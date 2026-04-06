# Gasless 购买与 SerialPermit 安全设计

## 背景

MyShop 支持两种购买入口：

- `buy(itemId, quantity, recipient, extraData)`：普通 EOA 直接调用，`msg.sender` 是买家。
- `buyGasless(itemId, quantity, recipient, payer, extraData)`：为 ERC-4337 账户抽象（AA）设计，`msg.sender` 是 Bundler/EntryPoint 或智能钱包，真正的经济主体通过 `payer` 参数标识。

当商品 `requiresSerial = true` 时，买家必须持有链下 Worker 签发的 `SerialPermit`，合约才会放行购买。这个机制是"先预约串号，再购买"的实现基础。

---

## SerialPermit EIP-712 结构体

```solidity
// 签名类型字符串
"SerialPermit(uint256 itemId,address buyer,address recipient,bytes32 serialHash,uint256 deadline,uint256 nonce)"
```

| 字段 | 说明 |
|---|---|
| `itemId` | 购买的商品 ID |
| `buyer` | 经济主体地址（签名人/付款人身份），普通购买时 = `msg.sender`，gasless 时 = `payer` |
| `recipient` | **NFT 接收地址**（锁定在签名中，不可篡改） |
| `serialHash` | 串号的 `keccak256` 哈希 |
| `deadline` | 签名有效期（Unix 时间戳） |
| `nonce` | 防重放随机数（链上 `usedNonces[buyer][nonce]` 记录） |

`recipient` 被纳入签名结构体是 **Option B 安全升级**（见下方威胁模型）的核心改动，在此之前 recipient 不在签名覆盖范围内。

---

## buyGasless 流程

```
EOA (买家)
  │
  │ 1. 向 Worker 请求 SerialPermit
  │    GET /serial-permit?itemId=X&buyer=EOA&recipient=EOA&serial=...
  │
Worker (链下)
  │ 2. 签名 EIP-712 SerialPermit（含 recipient）
  │    返回 extraData = abi.encode(serialHash, deadline, nonce, sig)
  │
EOA (买家)
  │ 3. 把 extraData 交给 AA 钱包，构造 UserOperation
  │
AA Wallet / Bundler
  │ 4. 调用 buyGasless(itemId, qty, recipient=EOA, payer=EOA, extraData)
  │    msg.sender = AA Wallet
  │
MyShopItems 合约
  │ 5. effectivePayer = payer（= EOA）
  │ 6. _verifySerial(itemId, buyer=EOA, recipient=EOA, extraData)
  │    ↳ 重构 EIP-712 digest（含 recipient）
  │    ↳ 验证签名 → 必须匹配 serialSigner
  │    ↳ 标记 usedNonces[EOA][nonce] = true
  │ 7. token.transferFrom(msg.sender=AA Wallet, ...) ← 付款来自 AA 钱包
  │ 8. nft.mint(recipient=EOA)                      ← NFT 发给 EOA
  │ 9. action.execute(...)
```

**关键点**：
- 身份（`buyer`/`nonce` 归属）= EOA（即 payer）
- 付款来源 = `msg.sender`（即 AA 钱包，由 AA 钱包持有并 approve USDC/ERC20）
- NFT 接收 = `recipient`（必须与 permit 签名中的 recipient 一致）

---

## 威胁模型：nonce 劫持攻击

### 攻击描述

假设攻击者持有受害者（victim EOA）的 `SerialPermit`（例如通过监听公开 mempool 或其他途径获取）。

**攻击目标**：消耗 victim 的 nonce，同时让自己接收 NFT。

**攻击手法（Option B 之前）**：

```
攻击者调用：
  buyGasless(itemId, 1, recipient=attacker, payer=victim, extraData)

结果（修复前）：
  - usedNonces[victim][nonce] = true  ← victim 的 nonce 被消耗
  - NFT 发给 attacker                  ← 攻击者获益
  - 付款来自 attacker（msg.sender）    ← 攻击者付了钱，但拿到了 NFT
```

这对 victim 造成的伤害：原本预留的 nonce 被消耗，victim 再用同一 permit 购买时会被 `NonceUsed` 拒绝，需要重新向 Worker 申请新 permit。

### Option A（已弃用）：运行时 recipient 守卫

```solidity
// buyGasless 中添加：
if (payer != msg.sender) {
    if (recipient != effectivePayer) revert InvalidAddress();
}
```

**问题**：禁止了 gasless 场景下的赠送/代购流（即 AA 钱包代替 EOA 购买，但 NFT 送给第三方），使 buyGasless 的能力退化为只能自购。

### Option B（当前实现）：recipient 锁入签名

`recipient` 被加入 EIP-712 `SerialPermit` 结构体，由 Worker 在签名时锁定。

**攻击者尝试改变 recipient**：
```
攻击者调用：
  buyGasless(itemId, 1, recipient=attacker, payer=victim, extraData)
  
合约重构 digest：
  hash(itemId=X, buyer=victim, recipient=attacker, serialHash, deadline, nonce)
  
与签名 digest（recipient=victim）不匹配 → InvalidSignature → 回滚

结果：
  - victim 的 nonce 未被消耗 ✓
  - 攻击者无法获益 ✓
  - 付款也未发生（tx 回滚）✓
```

**攻击者如果只能以 recipient=victim 调用**（即被迫让 NFT 给 victim）：
- 经济上对攻击者无意义（自己付钱，victim 得到 NFT）
- victim 反而拿到了本来就想买的 NFT，且 nonce 被合理消耗
- 此场景被视为"无害"

### 对比

| | Option A（运行时守卫） | Option B（recipient 锁签）|
|---|---|---|
| 防御原理 | 限制 recipient 只能等于 payer | 签名绑定 recipient，篡改必失败 |
| 是否支持 gasless 赠送 | 否（recipient 必须等于 payer）| 是（Worker 签名时锁定任意 recipient）|
| 攻击者劫持 nonce | 会被 InvalidAddress 阻止 | 会被 InvalidSignature 阻止 |
| Permit TTL 要求 | 需要较短（5 分钟）| 同样建议短 TTL（防止泄露窗口期）|

---

## Worker API 变化

### `/serial-permit`（普通购买）

```
GET /serial-permit?itemId=&buyer=&serial=&recipient=&deadline=&nonce=
```

新增参数：
- `recipient`（可选）：NFT 接收地址，默认 = `buyer`

签名消息新增字段：
```js
types: {
  SerialPermit: [
    { name: "itemId",     type: "uint256" },
    { name: "buyer",      type: "address" },
    { name: "recipient",  type: "address" },   // ← 新增
    { name: "serialHash", type: "bytes32"  },
    { name: "deadline",   type: "uint256"  },
    { name: "nonce",      type: "uint256"  },
  ]
}
```

### `/gasless-permit`（AA 钱包购买）

```
POST /gasless-permit
Body: { itemId, buyer, recipient, serial, deadline, nonce }
```

同样签名 `recipient`，字段名在消息中为 `gaslessRecipient`（与普通 serial-permit 的 `recipient` 字段均对应合约中的 `recipient`）。

---

## Permit 有效期与重试

**为什么 TTL 要短（5 分钟）？**

Permit 泄露的时间窗口越短，攻击者能利用的时间越少。即使 Option B 已从根本上防止了 nonce 劫持，短 TTL 仍然是深度防御的一环。

**如果 permit 过期了怎么办？**

`buy()` 和 `buyGasless()` 是链上原子交易：
- 如果 permit 已过期（`block.timestamp > deadline`），合约 revert，**交易失败不扣款**
- 代币的 `transferFrom` 发生在 permit 校验**之后**，所以过期 → revert → 无任何状态变化
- 买家只需重新向 Worker 请求新 permit，再发起购买即可

**注意**：前端应在发交易前检查 `deadline`，避免因网络延迟导致 permit 在确认前过期。

---

## 合约核心改动（feat/m2）

涉及文件：`contracts/src/MyShopItems.sol`

```solidity
// buyGasless — 移除运行时 recipient 守卫
function buyGasless(uint256 itemId, uint256 quantity, address recipient, address payer, bytes calldata extraData)
    external payable returns (uint256 firstTokenId)
{
    address effectivePayer = payer == address(0) ? msg.sender : payer;
    // recipient 已包含在 SerialPermit 签名中，Worker 在签发时锁定 NFT 接收方。
    return _buy(itemId, quantity, recipient, effectivePayer, extraData);
}

// _buy → _verifySerial 传入 recipient
function _buy(...) internal returns (uint256) {
    ...
    serialHash = _verifySerial(itemId, buyer, recipient, extraData);
    ...
}

// _verifySerial — 新增 recipient 参数
function _verifySerial(uint256 itemId, address buyer, address recipient, bytes calldata extraData)
    internal returns (bytes32)
{
    ...
    bytes32 digest = _hashTypedDataV4(
        _hashSerialPermit(itemId, buyer, recipient, serialHash, deadline, nonce)
    );
    if (ECDSA.recover(digest, sig) != serialSigner) revert InvalidSignature();
    ...
}

// _hashSerialPermit — 新增 recipient
function _hashSerialPermit(uint256 itemId, address buyer, address recipient, ...)
    internal pure returns (bytes32)
{
    return keccak256(abi.encode(
        keccak256("SerialPermit(uint256 itemId,address buyer,address recipient,bytes32 serialHash,uint256 deadline,uint256 nonce)"),
        itemId, buyer, recipient, serialHash, deadline, nonce
    ));
}
```

**破坏性变更**：此改动修改了 EIP-712 签名域结构，已有的 SerialPermit 签名（不含 recipient）将与新合约不兼容。部署新合约后，所有 permit 须由更新后的 Worker 重新签发。

---

## 测试覆盖（feat/m2）

`contracts/test/MyShopItemsGasless.t.sol` 覆盖以下场景：

| 测试名 | 场景 |
|---|---|
| `test_BuyGasless_SameAsRegularBuy` | payer=0，buyGasless 等效于普通 buy |
| `test_BuyGasless_ExplicitPayer` | AA 钱包代 EOA 购买，permit 签名含 recipient=EOA |
| `test_BuyGasless_ExplicitPayer_RecipientMismatch_Reverts` | permit 锁定 recipient=EOA，攻击者传 recipient=attacker → InvalidSignature |
| `test_BuyGasless_ForcedRecipientEqualsPayer_AttackerPaysVictimReceives` | 攻击者被迫以 recipient=EOA 调用，EOA 得 NFT，攻击无意义 |
| `test_BuyGasless_PayerZero_RecipientFree` | payer=0 时无 recipient 限制，可自由赠送 |
| `test_BuyGasless_ExplicitPayer_WrongPermitSigner_Reverts` | permit 签名错误 buyer → InvalidSignature |
| `test_BuyGasless_ReplayProtection` | nonce 重放 → NonceUsed |
| `test_BuyGasless_PayerNonceConsumption_NowBlocked` | 攻击者改 recipient → InvalidSignature，victim nonce 不被消耗 |
