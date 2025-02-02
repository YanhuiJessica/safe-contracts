import { getCompatFallbackHandler } from "./../utils/setup";
import { calculateSafeMessageHash, signHash, buildContractSignature } from "./../../src/utils/execution";
import { expect } from "chai";
import { deployments, waffle } from "hardhat";
import "@nomiclabs/hardhat-ethers";
import { AddressZero } from "@ethersproject/constants";
import { getSafeTemplate, getSafeWithOwners } from "../utils/setup";
import {
    safeSignTypedData,
    executeTx,
    safeSignMessage,
    calculateSafeTransactionHash,
    safeApproveHash,
    buildSafeTransaction,
    logGas,
    calculateSafeDomainSeparator,
    preimageSafeTransactionHash,
    buildSignatureBytes,
} from "../../src/utils/execution";
import { chainId } from "../utils/encoding";

describe("Safe", async () => {
    const [user1, user2, user3, user4, user5] = waffle.provider.getWallets();

    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const compatFallbackHandler = await getCompatFallbackHandler();
        const safe = await getSafeWithOwners([user1.address], 1, compatFallbackHandler.address);
        const safeWithCompatFbHandlerIface = compatFallbackHandler.attach(safe.address);

        return {
            safe,
            compatFallbackHandler,
            safeWithCompatFbHandlerIface,
        };
    });

    describe("domainSeparator", async () => {
        it("should be correct according to EIP-712", async () => {
            const { safe } = await setupTests();
            const domainSeparator = calculateSafeDomainSeparator(safe, await chainId());
            await expect(await safe.domainSeparator()).to.be.eq(domainSeparator);
        });
    });

    describe("getTransactionHash", async () => {
        it("should correctly calculate EIP-712 hash", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const typedDataHash = calculateSafeTransactionHash(safe, tx, await chainId());
            await expect(
                await safe.getTransactionHash(
                    tx.to,
                    tx.value,
                    tx.data,
                    tx.operation,
                    tx.safeTxGas,
                    tx.baseGas,
                    tx.gasPrice,
                    tx.gasToken,
                    tx.refundReceiver,
                    tx.nonce,
                ),
            ).to.be.eq(typedDataHash);
        });
    });

    describe("approveHash", async () => {
        it("approving should only be allowed for owners", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signerSafe = safe.connect(user2);
            await expect(signerSafe.approveHash(txHash)).to.be.revertedWith("GS030");
        });

        it("approving should emit event", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            await expect(safe.approveHash(txHash)).emit(safe, "ApproveHash").withArgs(txHash, user1.address);
        });
    });

    describe("execTransaction", async () => {
        it("should fail if signature points into static part", async () => {
            const { safe } = await setupTests();
            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000020" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000000"; // Some data to read
            await expect(safe.execTransaction(safe.address, 0, "0x", 0, 0, 0, 0, AddressZero, AddressZero, signatures)).to.be.revertedWith(
                "GS021",
            );
        });

        it("should fail if sigantures data is not present", async () => {
            const { safe } = await setupTests();

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00"; // r, s, v

            await expect(safe.execTransaction(safe.address, 0, "0x", 0, 0, 0, 0, AddressZero, AddressZero, signatures)).to.be.revertedWith(
                "GS022",
            );
        });

        it("should fail if sigantures data is too short", async () => {
            const { safe } = await setupTests();

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000020"; // length

            await expect(safe.execTransaction(safe.address, 0, "0x", 0, 0, 0, 0, AddressZero, AddressZero, signatures)).to.be.revertedWith(
                "GS023",
            );
        });

        it("should be able to use EIP-712 for signature generation", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(
                logGas(
                    "Execute cancel transaction with EIP-712 signature",
                    executeTx(safe, tx, [await safeSignTypedData(user1, safe, tx)]),
                ),
            ).to.emit(safe, "ExecutionSuccess");
        });

        it("should not be able to use different chainId for signing", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(executeTx(safe, tx, [await safeSignTypedData(user1, safe, tx, 1)])).to.be.revertedWith("GS026");
        });

        it("should be able to use Signed Ethereum Messages for signature generation", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(
                logGas(
                    "Execute cancel transaction with signed Ethereum message",
                    executeTx(safe, tx, [await safeSignMessage(user1, safe, tx)]),
                ),
            ).to.emit(safe, "ExecutionSuccess");
        });

        it("msg.sender does not need to approve before", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(
                logGas(
                    "Without pre approved signature for msg.sender",
                    executeTx(safe, tx, [await safeApproveHash(user1, safe, tx, true)]),
                ),
            ).to.emit(safe, "ExecutionSuccess");
        });

        it("if not msg.sender on-chain approval is required", async () => {
            const { safe } = await setupTests();
            const user2Safe = safe.connect(user2);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(executeTx(user2Safe, tx, [await safeApproveHash(user1, safe, tx, true)])).to.be.revertedWith("GS025");
        });

        it("should be able to use pre approved hashes for signature generation", async () => {
            const { safe } = await setupTests();
            const user2Safe = safe.connect(user2);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const approveHashSig = await safeApproveHash(user1, safe, tx);
            expect(await safe.approvedHashes(user1.address, txHash)).to.be.eq(1);
            await expect(logGas("With pre approved signature", executeTx(user2Safe, tx, [approveHashSig]))).to.emit(
                safe,
                "ExecutionSuccess",
            );
            // Approved hash should not reset automatically
            expect(await safe.approvedHashes(user1.address, txHash)).to.be.eq(1);
        });

        it("should revert if threshold is not set", async () => {
            await setupTests();
            const safe = await getSafeTemplate();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(executeTx(safe, tx, [])).to.be.revertedWith("GS001");
        });

        it("should revert if not the required amount of signature data is provided", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(executeTx(safe, tx, [])).to.be.revertedWith("GS020");
        });

        it("should not be able to use different signature type of same owner", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            await expect(
                executeTx(safe, tx, [
                    await safeApproveHash(user1, safe, tx),
                    await safeSignTypedData(user1, safe, tx),
                    await safeSignTypedData(user3, safe, tx),
                ]),
            ).to.be.revertedWith("GS026");
        });

        it("should be able to mix all signature types", async () => {
            await setupTests();
            const compatFallbackHandler = await getCompatFallbackHandler();
            const signerSafe = await getSafeWithOwners([user5.address], 1, compatFallbackHandler.address);
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address, signerSafe.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });

            const safeMessageHash = calculateSafeMessageHash(
                signerSafe,
                calculateSafeTransactionHash(safe, tx, await chainId()),
                await chainId(),
            );

            const signerSafeOwnerSignature = await signHash(user5, safeMessageHash);
            const signerSafeSig = buildContractSignature(signerSafe.address, signerSafeOwnerSignature.data);
            await expect(
                logGas(
                    "Execute cancel transaction with 5 owners (1 owner is another Safe)",
                    executeTx(safe, tx, [
                        await safeApproveHash(user1, safe, tx, true),
                        await safeApproveHash(user4, safe, tx),
                        await safeSignTypedData(user2, safe, tx),
                        await safeSignTypedData(user3, safe, tx),
                        signerSafeSig,
                    ]),
                ),
            ).to.emit(safe, "ExecutionSuccess");
        });
    });

    describe("checkSignatures", async () => {
        it("should fail if signature points into static part", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });

            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000020" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000000"; // Some data to read
            await expect(safe.checkSignatures(txHash, "0x", signatures)).to.be.revertedWith("GS021");
        });

        it("should fail if signatures data is not present", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00"; // r, s, v

            await expect(safe.checkSignatures(txHash, txHashData, signatures)).to.be.revertedWith("GS022");
        });

        it("should fail if signatures data is too short", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000020"; // length

            await expect(safe.checkSignatures(txHash, txHashData, signatures)).to.be.revertedWith("GS023");
        });

        it("should not be able to use different chainId for signing", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeSignTypedData(user1, safe, tx, 1)]);
            await expect(safe.checkSignatures(txHash, txHashData, signatures)).to.be.revertedWith("GS026");
        });

        it("if not msg.sender on-chain approval is required", async () => {
            const { safe } = await setupTests();
            const user2Safe = safe.connect(user2);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeApproveHash(user1, safe, tx, true)]);
            await expect(user2Safe.checkSignatures(txHash, txHashData, signatures)).to.be.revertedWith("GS025");
        });

        it("should revert if threshold is not set", async () => {
            await setupTests();
            const safe = await getSafeTemplate();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            await expect(safe.checkSignatures(txHash, txHashData, "0x")).to.be.revertedWith("GS001");
        });

        it("should revert if not the required amount of signature data is provided", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            await expect(safe.checkSignatures(txHash, txHashData, "0x")).to.be.revertedWith("GS020");
        });

        it("should not be able to use different signature type of same owner", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx),
                await safeSignTypedData(user1, safe, tx),
                await safeSignTypedData(user3, safe, tx),
            ]);
            await expect(safe.checkSignatures(txHash, txHashData, signatures)).to.be.revertedWith("GS026");
        });

        it("should be able to mix all signature types", async () => {
            await setupTests();
            const compatFallbackHandler = await getCompatFallbackHandler();
            const signerSafe = await getSafeWithOwners([user5.address], 1, compatFallbackHandler.address);
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address, signerSafe.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const safeMessageHash = calculateSafeMessageHash(signerSafe, txHash, await chainId());
            const signerSafeOwnerSignature = await signHash(user5, safeMessageHash);
            const signerSafeSig = buildContractSignature(signerSafe.address, signerSafeOwnerSignature.data);

            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx, true),
                await safeApproveHash(user4, safe, tx),
                await safeSignTypedData(user2, safe, tx),
                await safeSignTypedData(user3, safe, tx),
                signerSafeSig,
            ]);

            await safe.checkSignatures(txHash, "0x", signatures);
        });
    });

    describe("checkNSignatures", async () => {
        it("should fail if signature points into static part", async () => {
            const { safe } = await setupTests();

            const sender = await safe.signer.getAddress();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000020" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000000"; // Some data to read
            await expect(safe.checkNSignatures(sender, txHash, "0x", signatures, 1)).to.be.revertedWith("GS021");
        });

        it("should fail if signatures data is not present", async () => {
            const { safe } = await setupTests();
            const sender = await safe.signer.getAddress();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00"; // r, s, v

            await expect(safe.checkNSignatures(sender, txHash, "0x", signatures, 1)).to.be.revertedWith("GS022");
        });

        it("should fail if signatures data is too short", async () => {
            const { safe } = await setupTests();

            const sender = await safe.signer.getAddress();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHashData = preimageSafeTransactionHash(safe, tx, await chainId());
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000020"; // length

            await expect(safe.checkNSignatures(sender, txHash, txHashData, signatures, 1)).to.be.revertedWith("GS023");
        });

        it("should not be able to use different chainId for signing", async () => {
            const { safe } = await setupTests();
            const sender = await safe.signer.getAddress();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeSignTypedData(user1, safe, tx, 1)]);
            await expect(safe.checkNSignatures(sender, txHash, "0x", signatures, 1)).to.be.revertedWith("GS026");
        });

        it("if not msg.sender on-chain approval is required", async () => {
            const { safe } = await setupTests();
            const user2Safe = safe.connect(user2);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeApproveHash(user1, safe, tx, true)]);
            await expect(user2Safe.checkNSignatures(AddressZero, txHash, "0x", signatures, 1)).to.be.revertedWith("GS025");
        });

        it("should revert if not the required amount of signature data is provided", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            await expect(safe.checkNSignatures(AddressZero, txHash, "0x", "0x", 1)).to.be.revertedWith("GS020");
        });

        it("should not be able to use different signature type of same owner", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx),
                await safeSignTypedData(user1, safe, tx),
                await safeSignTypedData(user3, safe, tx),
            ]);
            await expect(safe.checkNSignatures(AddressZero, txHash, "0x", signatures, 3)).to.be.revertedWith("GS026");
        });

        it("should be able to mix all signature types", async () => {
            await setupTests();
            const compatFallbackHandler = await getCompatFallbackHandler();
            const signerSafe = await getSafeWithOwners([user5.address], 1, compatFallbackHandler.address);
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address, signerSafe.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const safeMessageHash = calculateSafeMessageHash(signerSafe, txHash, await chainId());
            const signerSafeOwnerSignature = await signHash(user5, safeMessageHash);
            const signerSafeSig = buildContractSignature(signerSafe.address, signerSafeOwnerSignature.data);

            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx, true),
                await safeApproveHash(user4, safe, tx),
                await safeSignTypedData(user2, safe, tx),
                await safeSignTypedData(user3, safe, tx),
                signerSafeSig,
            ]);

            await safe.checkNSignatures(user1.address, txHash, "0x", signatures, 5);
        });

        it("should be able to require no signatures", async () => {
            const { safe } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            await safe.checkNSignatures(AddressZero, txHash, "0x", "0x", 0);
        });

        it("should be able to require less signatures than the threshold", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeSignTypedData(user3, safe, tx)]);

            await safe.checkNSignatures(AddressZero, txHash, "0x", signatures, 1);
        });

        it("should be able to require more signatures than the threshold", async () => {
            await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address, user4.address], 2);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx, true),
                await safeApproveHash(user4, safe, tx),
                await safeSignTypedData(user2, safe, tx),
            ]);
            const sender = await safe.signer.getAddress();
            // Should fail as only 3 signatures are provided
            await expect(safe.checkNSignatures(sender, txHash, "0x", signatures, 4)).to.be.revertedWith("GS020");

            await safe.checkNSignatures(sender, txHash, "0x", signatures, 3);
        });

        it("Should accept an arbitrary msg.sender", async () => {
            await setupTests();

            const safe = await getSafeWithOwners([user1.address]);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures = buildSignatureBytes([await safeApproveHash(user1, safe, tx, true)]);
            const safeConnectUser2 = safe.connect(user2);

            await safeConnectUser2.checkNSignatures(user1.address, txHash, "0x", signatures, 1);
        });
    });

    describe("checkNSignatures (legacy)", async () => {
        it("should use msg.sender executing the check", async () => {
            // We attach the safe to user2 but the only owner of the safe is user1
            // If it fails to preserve the msg.sender, it will fail because user2 is not an owner
            const { safe, safeWithCompatFbHandlerIface } = await setupTests();

            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures = buildSignatureBytes([await safeApproveHash(user1, safe, tx, true)]);
            const safeConnectedUser2 = safeWithCompatFbHandlerIface.connect(user2);

            await expect(safeConnectedUser2.checkNSignatures(txHash, "0x", signatures, 1)).to.be.revertedWith("GS025");
        });

        it("should fail if signature points into static part", async () => {
            const { safe, safeWithCompatFbHandlerIface } = await setupTests();

            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000020" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000000"; // Some data to read
            await expect(safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 1)).to.be.revertedWith("GS021");
        });

        it("should fail if signatures data is not present", async () => {
            const { safe, safeWithCompatFbHandlerIface } = await setupTests();

            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00"; // r, s, v

            await expect(safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 1)).to.be.revertedWith("GS022");
        });

        it("should fail if signatures data is too short", async () => {
            const { safe, safeWithCompatFbHandlerIface } = await setupTests();

            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const signatures =
                "0x" +
                "000000000000000000000000" +
                user1.address.slice(2) +
                "0000000000000000000000000000000000000000000000000000000000000041" +
                "00" + // r, s, v
                "0000000000000000000000000000000000000000000000000000000000000020"; // length

            await expect(safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 1)).to.be.revertedWith("GS023");
        });

        it("should not be able to use different chainId for signing", async () => {
            const { safe, safeWithCompatFbHandlerIface } = await setupTests();

            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeSignTypedData(user1, safe, tx, 1)]);
            await expect(safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 1)).to.be.revertedWith("GS026");
        });

        it("if not msg.sender on-chain approval is required", async () => {
            const { safe, safeWithCompatFbHandlerIface } = await setupTests();
            const user2Safe = safeWithCompatFbHandlerIface.connect(user2);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeApproveHash(user1, safe, tx, true)]);
            await expect(user2Safe.checkNSignatures(txHash, "0x", signatures, 1)).to.be.revertedWith("GS025");
        });

        it("should revert if not the required amount of signature data is provided", async () => {
            const { compatFallbackHandler } = await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address], 3, compatFallbackHandler.address);
            const safeWithCompatFbHandlerIface = compatFallbackHandler.attach(safe.address);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            await expect(safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", "0x", 1)).to.be.revertedWith("GS020");
        });

        it("should not be able to use different signature type of same owner", async () => {
            const { compatFallbackHandler } = await setupTests();
            const safe = await getSafeWithOwners([user1.address, user2.address, user3.address], 3, compatFallbackHandler.address);
            const safeWithCompatFbHandlerIface = compatFallbackHandler.attach(safe.address);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx),
                await safeSignTypedData(user1, safe, tx),
                await safeSignTypedData(user3, safe, tx),
            ]);
            await expect(safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 3)).to.be.revertedWith("GS026");
        });

        it("should be able to mix all signature types", async () => {
            await setupTests();
            const compatFallbackHandler = await getCompatFallbackHandler();
            const signerSafe = await getSafeWithOwners([user5.address], 1, compatFallbackHandler.address);
            const safe = await getSafeWithOwners(
                [user1.address, user2.address, user3.address, user4.address, signerSafe.address],
                5,
                compatFallbackHandler.address,
            );
            const safeWithCompatFbHandlerIface = compatFallbackHandler.attach(safe.address);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            const safeMessageHash = calculateSafeMessageHash(signerSafe, txHash, await chainId());
            const signerSafeOwnerSignature = await signHash(user5, safeMessageHash);
            const signerSafeSig = buildContractSignature(signerSafe.address, signerSafeOwnerSignature.data);

            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx, true),
                await safeApproveHash(user4, safe, tx),
                await safeSignTypedData(user2, safe, tx),
                await safeSignTypedData(user3, safe, tx),
                signerSafeSig,
            ]);

            await safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 5);
        });

        it("should be able to require no signatures", async () => {
            const { safe, safeWithCompatFbHandlerIface } = await setupTests();
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());

            await safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", "0x", 0);
        });

        it("should be able to require less signatures than the threshold", async () => {
            const { compatFallbackHandler } = await setupTests();
            const safe = await getSafeWithOwners(
                [user1.address, user2.address, user3.address, user4.address],
                4,
                compatFallbackHandler.address,
            );
            const safeWithCompatFbHandlerIface = compatFallbackHandler.attach(safe.address);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([await safeSignTypedData(user3, safe, tx)]);

            await safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 1);
        });

        it("should be able to require more signatures than the threshold", async () => {
            const { compatFallbackHandler } = await setupTests();
            const safe = await getSafeWithOwners(
                [user1.address, user2.address, user3.address, user4.address],
                2,
                compatFallbackHandler.address,
            );
            const safeWithCompatFbHandlerIface = compatFallbackHandler.attach(safe.address);
            const tx = buildSafeTransaction({ to: safe.address, nonce: await safe.nonce() });
            const txHash = calculateSafeTransactionHash(safe, tx, await chainId());
            const signatures = buildSignatureBytes([
                await safeApproveHash(user1, safe, tx, true),
                await safeApproveHash(user4, safe, tx),
                await safeSignTypedData(user2, safe, tx),
            ]);

            // Should fail as only 3 signatures are provided
            await expect(safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 4)).to.be.revertedWith("GS020");

            await safeWithCompatFbHandlerIface.checkNSignatures(txHash, "0x", signatures, 3);
        });
    });
});
