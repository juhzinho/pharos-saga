// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test contracts for running the saga for real on Pharos Atlantic Testnet, where FaroSwap and Morpho are not
// deployed. Each one keeps the exact interface the saga uses on Pacific, so the saga engine is unchanged:
//   SagaWPHRS       a WETH9-style wrapped PHRS   (deposit / withdraw / Deposit / Withdrawal, like WPROS)
//   SagaTestRouter  the FaroSwap DODORouteProxy mixSwap signature, backed by one constant-product pool
//                   WPHRS/USDC (0.30% fee) holding its own reserves; it pulls the input with transferFrom, so the
//                   saga's approve step is real
//   SagaTestVault   an OpenZeppelin ERC-4626 vault over Circle's Atlantic USDC (like the Morpho USDC vaults)
// Test funds only. Not audited; not for mainnet.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract SagaWPHRS {
    string public constant name = "Wrapped PHRS (saga test)";
    string public constant symbol = "WPHRS";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "balance");
        balanceOf[msg.sender] -= wad;
        (bool ok, ) = msg.sender.call{value: wad}("");
        require(ok, "send");
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "balance");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "allowance");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}

interface IWrapped {
    function deposit() external payable;
}

contract SagaTestRouter {
    using SafeERC20 for IERC20;

    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address public immutable wphrs;
    address public immutable usdc;
    address public immutable owner;

    event Swap(address indexed sender, address indexed fromToken, address indexed toToken, uint256 amountIn, uint256 amountOut);

    constructor(address _wphrs, address _usdc) {
        wphrs = _wphrs;
        usdc = _usdc;
        owner = msg.sender;
    }

    /// Same signature as FaroSwap's DODORouteProxy.mixSwap; the routing arguments are accepted and ignored.
    function mixSwap(
        address fromToken,
        address toToken,
        uint256 fromTokenAmount,
        uint256 expReturnAmount,
        uint256 minReturnAmount,
        address[] calldata,
        address[] calldata,
        address[] calldata,
        uint256,
        bytes[] calldata,
        bytes calldata,
        uint256 deadLine
    ) external payable returns (uint256 out) {
        require(block.timestamp <= deadLine, "deadline");
        address tokenIn = fromToken;
        if (fromToken == NATIVE) {
            require(msg.value == fromTokenAmount, "value");
            IWrapped(wphrs).deposit{value: msg.value}();
            tokenIn = wphrs;
        } else {
            require(msg.value == 0, "no value");
            IERC20(fromToken).safeTransferFrom(msg.sender, address(this), fromTokenAmount);
        }
        require((tokenIn == wphrs && toToken == usdc) || (tokenIn == usdc && toToken == wphrs), "pair");
        out = getAmountOut(tokenIn, fromTokenAmount, true);
        if (out > expReturnAmount) out = expReturnAmount; // like the proxy: never pays more than expected
        require(out >= minReturnAmount, "ReturnAmountIsNotEnough");
        IERC20(toToken).safeTransfer(msg.sender, out);
        emit Swap(msg.sender, tokenIn, toToken, fromTokenAmount, out);
    }

    /// x*y=k with a 0.30% fee. `received` = the input is already in the pool's balance.
    function getAmountOut(address tokenIn, uint256 amountIn, bool received) public view returns (uint256) {
        address tokenOut = tokenIn == wphrs ? usdc : wphrs;
        uint256 rIn = IERC20(tokenIn).balanceOf(address(this)) - (received ? amountIn : 0);
        uint256 rOut = IERC20(tokenOut).balanceOf(address(this));
        uint256 inFee = amountIn * 997;
        return (inFee * rOut) / (rIn * 1000 + inFee);
    }

    /// The deployer can take the test liquidity back.
    function withdrawLiquidity(address token, uint256 amount, address to) external {
        require(msg.sender == owner, "owner");
        IERC20(token).safeTransfer(to, amount);
    }
}

/// A 6-decimal test stablecoin with Circle USDC's EIP-3009 interface (the x402 "exact" payment): used on Atlantic
/// while Circle's testnet faucet was under maintenance. EIP-712 domain: name "Test USDC", version "2".
contract SagaTestUSDC is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    address public immutable owner;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("Test USDC", "tUSDC") EIP712("Test USDC", "2") {
        owner = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function version() external pure returns (string memory) {
        return "2";
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// Test token: the deployer mints test balances.
    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "owner");
        _mint(to, amount);
    }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory signature) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function _transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory signature) internal {
        require(block.timestamp > validAfter, "authorization is not yet valid");
        require(block.timestamp < validBefore, "authorization is expired");
        require(!authorizationState[from][nonce], "authorization is used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)));
        require(SignatureChecker.isValidSignatureNow(from, digest, signature), "invalid signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}

contract SagaTestVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Saga Test USDC Vault", "stUSDC") ERC4626(asset_) {}

    /// 18-decimal shares over 6-decimal USDC, like the Morpho vaults the saga uses on Pacific.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }
}
