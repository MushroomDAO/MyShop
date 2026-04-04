# JuryContract 通用化改造建议

> 日期：2026-04-04  
> 状态：设计讨论  
> 目标：在不改变核心逻辑的前提下，让 JuryContract 兼容 task 验证、兑换纠纷以及未来其他场景

---

## 1. 现状分析

读取当前 JuryContract 代码（`/contracts/src/JuryContract.sol`）后，核心问题集中在三点：

### 1.1 agentId 绑定过于具体

```solidity
struct Task {
    uint256 agentId;   // ← 硬绑定 agent，纠纷场景无对应概念
    ...
}
// 任务 hash 也包含 agentId
taskHash = keccak256(abi.encode(msg.sender, _taskCounter, block.timestamp, params.agentId));
```

对于兑换纠纷，没有 "agentId"，有的是 `purchaseId`（购买凭证 ID）。

### 1.2 没有回调机制

`finalizeTask()` 完成后没有通知外部合约的机制。调用方（如 DisputeEscrow）必须主动轮询结果，无法做到"裁决完成 → 自动释放资金"。

### 1.3 正票阈值硬编码为 50

```solidity
if (response >= 50) {   // 硬编码，不可配置
    task.positiveVotes++;
}
```

不同场景对"支持"的定义可能不同（纠纷场景可能需要 ≥60 才算支持买家）。

---

## 2. 改造方案：最小改动，向后完全兼容

### 2.1 Task 结构扩展

```solidity
struct Task {
    // ── 原有字段（不变）──────────────────────────────
    uint256 agentId;          // ERC-8004 兼容保留，agent 场景使用
    bytes32 taskHash;
    string evidenceUri;
    TaskType taskType;
    uint256 reward;
    uint256 deadline;
    TaskStatus status;
    uint256 minJurors;
    uint256 consensusThreshold;
    uint256 totalVotes;
    uint256 positiveVotes;
    uint8 finalResponse;

    // ── 新增字段（扩展，默认值保持原行为）────────────
    bytes32 contextId;        // 通用上下文 ID（agent场景=0，纠纷场景=purchaseId）
    bytes32 contextType;      // 上下文类型标记（语义标签，不影响逻辑）
    address callbackAddress;  // 裁决完成后回调的地址（0=不回调，原有行为）
    uint8 positiveThreshold;  // 正票分数线（0=使用默认值50）
}
```

### 2.2 TaskParams 扩展

```solidity
struct TaskParams {
    // ── 原有字段（不变）──────────────────────────────
    uint256 agentId;
    TaskType taskType;
    string evidenceUri;
    uint256 reward;
    uint256 deadline;
    uint256 minJurors;
    uint256 consensusThreshold;

    // ── 新增字段────────────────────────────────────
    bytes32 contextId;        // 调用方自定义（购买纠纷传入 purchaseId）
    bytes32 contextType;      // keccak256("AGENT_VALIDATION") 或 keccak256("PURCHASE_DISPUTE")
    address callbackAddress;  // 裁决后回调接口实现地址
    uint8 positiveThreshold;  // 0 = 使用默认 50
}
```

### 2.3 核心逻辑修改（只有两处）

**修改 1：vote() 中的正票判断**

```solidity
// 原来
if (response >= 50) {
    task.positiveVotes++;
}

// 改为
uint8 threshold = task.positiveThreshold == 0 ? 50 : task.positiveThreshold;
if (response >= threshold) {
    task.positiveVotes++;
}
```

**修改 2：finalizeTask() 末尾添加回调**

```solidity
// 末尾追加（原有逻辑完全不变）
if (task.callbackAddress != address(0)) {
    bool consensusReached = (task.status == TaskStatus.COMPLETED);
    try ITaskCallback(task.callbackAddress).onTaskFinalized(
        taskHash,
        task.finalResponse,
        consensusReached
    ) {} catch {} // 回调失败不影响裁决结果
}
```

### 2.4 新增接口 ITaskCallback

```solidity
interface ITaskCallback {
    /// @notice JuryContract 裁决完成后回调
    /// @param taskHash   任务哈希
    /// @param finalScore 最终平均分（0-100）
    /// @param reached    是否达到共识阈值（true = COMPLETED，false = DISPUTED）
    function onTaskFinalized(
        bytes32 taskHash,
        uint8 finalScore,
        bool reached
    ) external;
}
```

### 2.5 contextType 标准值（建议）

```solidity
bytes32 constant CONTEXT_AGENT_VALIDATION  = keccak256("AGENT_VALIDATION");
bytes32 constant CONTEXT_PURCHASE_DISPUTE  = keccak256("PURCHASE_DISPUTE");
bytes32 constant CONTEXT_TASK_DISPUTE      = keccak256("TASK_DISPUTE");
// 未来扩展：CONTEXT_DAO_VOTE, CONTEXT_CONTENT_MODERATION...
```

---

## 3. 改造后对各场景的支持

### 3.1 原有 Agent 验证场景（不变）

```solidity
JuryContract.createTask(TaskParams({
    agentId: 42,
    contextId: bytes32(0),               // 不使用
    contextType: CONTEXT_AGENT_VALIDATION,
    callbackAddress: address(0),          // 不回调
    positiveThreshold: 0,                 // 默认 50
    // ...其余字段同原来
}));
// ← 行为与改造前完全相同
```

### 3.2 兑换纠纷场景（新增）

```solidity
JuryContract.createTask(TaskParams({
    agentId: 0,                           // 无 agent
    contextId: bytes32(purchaseId),       // 购买 ID 作为上下文
    contextType: CONTEXT_PURCHASE_DISPUTE,
    callbackAddress: address(disputeEscrow), // 裁决后通知 DisputeEscrow
    positiveThreshold: 50,                // 50 = 支持买家
    // ...
}));

// 裁决完成后自动调用：
// DisputeEscrow.onTaskFinalized(taskHash, score, reached)
//   → score >= 50 且 reached=true → 退款给买家
//   → 否则 → 释放给卖家
```

### 3.3 Task 纠纷场景（兼容 MyTask）

```solidity
JuryContract.createTask(TaskParams({
    agentId: 0,
    contextId: bytes32(taskId),
    contextType: CONTEXT_TASK_DISPUTE,
    callbackAddress: address(taskEscrow),  // MyTask 的 TaskEscrow 实现 ITaskCallback
    positiveThreshold: 60,                 // 60 = 任务完成度达标线
    // ...
}));
```

---

## 4. 有了回调后，DisputeModule 还需要什么？

**改造后的架构：**

```
MyShopItems.buy()
  → 记录 purchaseId 和购买时间戳

DisputeEscrow.sol（MyShop 侧，新增，简单合约）
  职责：
    1. openDispute(purchaseId, evidenceUri)
         → 校验 7 天冷静期内
         → 从 shopTreasury 锁定资金
         → 调用 JuryContract.createTask(contextId=purchaseId, callback=this)
    2. onTaskFinalized(taskHash, score, reached)   ← 实现 ITaskCallback
         → 查询 taskHash → purchaseId 映射
         → score >= 50 且 reached → transferToBuyer()
         → 否则 → releaseToSeller()
    3. submitCounterEvidence(purchaseId, evidenceUri)
         → 卖家补充证据，调用 JuryContract.submitEvidence()

JuryContract（生态级，改造后的通用版）
  职责不变：陪审员管理、投票、共识计算
  新增：回调机制（只有 2 行代码）
```

**DisputeEscrow 非常简单**，大约 100-150 行 Solidity：
- 资金锁定/释放
- 实现 ITaskCallback
- 维护 taskHash → purchaseId 的映射

**不再需要"适配器"**：DisputeEscrow 是 MyShop 的业务合约，直接与改造后的 JuryContract 交互，语义完全匹配。

---

## 5. 改造成本评估

| 改动 | 影响范围 | 风险 |
|---|---|---|
| Task struct 新增 4 字段 | Gas 略增（+3 storage slot） | 低 |
| vote() 正票阈值可配置 | 1 行逻辑改动 | 极低 |
| finalizeTask() 添加回调 | 5 行，try-catch 保护 | 低（失败不影响裁决） |
| 新增 ITaskCallback 接口 | 新文件，无改动 | 无 |
| 原有测试全部通过 | 新字段有默认值 | 向后兼容 |

**结论：改造成本极低，收益极大。建议尽快推进，这使得 JuryContract 真正成为生态级通用仲裁合约。**

---

## 6. 需要协调的事项

1. **JuryContract 测试更新**：新增字段的测试用例（原有用例不变）
2. **contextType 常量标准化**：在生态共享配置中定义，所有调用方使用相同常量
3. **ITaskCallback 接口发布**：作为生态标准接口，与 IEligibilityValidator 一起管理
4. **DisputeEscrow.onTaskFinalized() 的访问控制**：只允许 JuryContract 调用（`require(msg.sender == juryContract)`）
