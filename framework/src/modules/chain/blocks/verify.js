/*
 * Copyright © 2018 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

'use strict';

const crypto = require('crypto');
const { Status: TransactionStatus } = require('@liskhq/lisk-transactions');
const blockVersion = require('./block_version');
const blocksLogic = require('./block');
const blocksUtils = require('./utils');
const transactionsModule = require('../transactions');
const Bignum = require('../helpers/bignum');

/**
 * Checks if block is in database.
 *
 * @private
 * @func checkExists
 * @param {Object} block - Full block
 * @param {function} cb - Callback function
 * @returns {function} cb - Callback function from params (through setImmediate)
 * @returns {Object} cb.err - Error if occurred
 */
const checkExists = async (storage, block) => {
	// Check if block id is already in the database (very low probability of hash collision)
	// TODO: In case of hash-collision, to me it would be a special autofork...
	// DATABASE: read only
	const isPersisted = await storage.entities.Block.isPersisted({
		id: block.id,
	});
	if (isPersisted) {
		throw new Error(`Block ${block.id} already exists`);
	}
};

/**
 * Check transactions - perform transactions validation when processing block.
 * FIXME: Some checks are probably redundant, see: logic.transactionPool
 *
 * @private
 * @func checkTransactions
 * @param {Object} block - Block object
 * @param {Object} transaction - Transaction object
 * @param  {boolean} checkExists - Check if transaction already exists in database
 * @param {function} cb - Callback function
 * @returns {function} cb - Callback function from params (through setImmediate)
 * @returns {Object} cb.err - Error if occurred
 */
const checkTransactions = async (storage, slots, block, exceptions) => {
	const { version, height, timestamp, transactions } = block;
	if (transactions.length === 0) {
		return;
	}
	const context = {
		blockVersion: version,
		blockHeight: height,
		blockTimestamp: timestamp,
	};

	const nonInertTransactions = transactions.filter(
		transaction =>
			!transactionsModule.checkIfTransactionIsInert(transaction, exceptions)
	);

	const nonAllowedTxResponses = transactionsModule
		.checkAllowedTransactions(context)(nonInertTransactions)
		.transactionsResponses.find(
			transactionResponse => transactionResponse.status !== TransactionStatus.OK
		);

	if (nonAllowedTxResponses) {
		throw nonAllowedTxResponses.errors;
	}

	const { transactionsResponses } = await transactionsModule.verifyTransactions(
		storage,
		slots,
		exceptions
	)(nonInertTransactions);

	const unverifiableTransactionsResponse = transactionsResponses.filter(
		transactionResponse => transactionResponse.status !== TransactionStatus.OK
	);

	if (unverifiableTransactionsResponse.length > 0) {
		throw unverifiableTransactionsResponse[0].errors;
	}
};

/**
 * Checks if block was generated by the right active delagate.
 *
 * @private
 * @func validateBlockSlot
 * @param {Object} block - Full block
 * @param {function} cb - Callback function
 * @returns {function} cb - Callback function from params (through setImmediate)
 * @returns {Object} cb.err - Error if occurred
 */
const validateBlockSlot = async (roundsModule, block) => {
	// Check if block was generated by the right active delagate. Otherwise, fork 3
	// DATABASE: Read only to mem_accounts to extract active delegate list
	try {
		await roundsModule.validateBlockSlot(block);
	} catch (error) {
		roundsModule.fork(block, 3);
		throw error;
	}
};

/**
 * Verify block signature.
 *
 * @private
 * @func verifySignature
 * @param {Object} block - Target block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifySignature = (block, result) => {
	let valid;

	try {
		valid = blocksLogic.verifySignature(block);
	} catch (error) {
		result.errors.push(error);
	}

	if (!valid) {
		result.errors.push(new Error('Failed to verify block signature'));
	}

	return result;
};

/**
 * Verify previous block.
 *
 * @private
 * @func verifyPreviousBlock
 * @param {Object} block - Target block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyPreviousBlock = (block, result) => {
	if (!block.previousBlock && block.height !== 1) {
		result.errors.push(new Error('Invalid previous block'));
	}
	return result;
};

/**
 * Verify block is not one of the last {BLOCK_SLOT_WINDOW} saved blocks.
 *
 * @private
 * @func verifyAgainstLastNBlockIds
 * @param {Object} block - Target block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyAgainstLastNBlockIds = (block, lastNBlockIds, result) => {
	if (lastNBlockIds.indexOf(block.id) !== -1) {
		result.errors.push(new Error('Block already exists in chain'));
	}

	return result;
};

/**
 * Verify block version.
 *
 * @private
 * @func verifyVersion
 * @param {Object} block - Target block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyVersion = (block, exceptions, result) => {
	if (!blockVersion.isValid(block.version, block.height, exceptions)) {
		result.errors.push(new Error('Invalid block version'));
	}

	return result;
};

/**
 * Verify block reward.
 *
 * @private
 * @func verifyReward
 * @param {Object} block - Target block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyReward = (blockReward, block, exceptions, result) => {
	const expectedReward = blockReward.calcReward(block.height);
	if (
		block.height !== 1 &&
		!expectedReward.isEqualTo(block.reward) &&
		!exceptions.blockReward.includes(block.id)
	) {
		result.errors.push(
			new Error(
				`Invalid block reward: ${block.reward} expected: ${expectedReward}`
			)
		);
	}

	return result;
};

/**
 * Verify block id.
 *
 * @private
 * @func verifyId
 * @param {Object} block - Target block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyId = (block, result) => {
	try {
		// Overwrite block ID
		block.id = blocksLogic.getId(block);
	} catch (error) {
		result.errors.push(error);
	}

	return result;
};

/**
 * Verify block payload (transactions).
 *
 * @private
 * @func verifyPayload
 * @param {Object} block - Target block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyPayload = (
	block,
	maxTransactionsPerBlock,
	maxPayloadLength,
	result
) => {
	if (block.payloadLength > maxPayloadLength) {
		result.errors.push(new Error('Payload length is too long'));
	}

	if (block.transactions.length !== block.numberOfTransactions) {
		result.errors.push(
			new Error('Included transactions do not match block transactions count')
		);
	}

	if (block.transactions.length > maxTransactionsPerBlock) {
		result.errors.push(
			new Error('Number of transactions exceeds maximum per block')
		);
	}

	let totalAmount = new Bignum(0);
	let totalFee = new Bignum(0);
	const payloadHash = crypto.createHash('sha256');
	const appliedTransactions = {};

	block.transactions.forEach(transaction => {
		let bytes;

		try {
			bytes = transaction.getBytes();
		} catch (e) {
			result.errors.push(e.toString());
		}

		if (appliedTransactions[transaction.id]) {
			result.errors.push(
				`Encountered duplicate transaction: ${transaction.id}`
			);
		}

		appliedTransactions[transaction.id] = transaction;
		if (bytes) {
			payloadHash.update(bytes);
		}
		totalAmount = totalAmount.plus(transaction.amount);
		totalFee = totalFee.plus(transaction.fee);
	});

	if (payloadHash.digest().toString('hex') !== block.payloadHash) {
		result.errors.push(new Error('Invalid payload hash'));
	}

	if (!totalAmount.isEqualTo(block.totalAmount)) {
		result.errors.push(new Error('Invalid total amount'));
	}

	if (!totalFee.isEqualTo(block.totalFee)) {
		result.errors.push(new Error('Invalid total fee'));
	}

	return result;
};

/**
 * Verify block for fork cause one.
 *
 * @private
 * @func verifyForkOne
 * @param {Object} block - Target block
 * @param {Object} lastBlock - Last block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyForkOne = (roundsModule, block, lastBlock, result) => {
	if (block.previousBlock && block.previousBlock !== lastBlock.id) {
		roundsModule.fork(block, 1);
		result.errors.push(
			new Error(
				`Invalid previous block: ${block.previousBlock} expected: ${
					lastBlock.id
				}`
			)
		);
	}

	return result;
};

/**
 * Verify block slot according to timestamp.
 *
 * @private
 * @func verifyBlockSlot
 * @param {Object} block - Target block
 * @param {Object} lastBlock - Last block
 * @param {Object} result - Verification results
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyBlockSlot = (slots, block, lastBlock, result) => {
	const blockSlotNumber = slots.getSlotNumber(block.timestamp);
	const lastBlockSlotNumber = slots.getSlotNumber(lastBlock.timestamp);

	if (
		blockSlotNumber > slots.getSlotNumber() ||
		blockSlotNumber <= lastBlockSlotNumber
	) {
		result.errors.push(new Error('Invalid block timestamp'));
	}

	return result;
};

/**
 * Verify block slot window according to application time.
 *
 * @private
 * @func verifyBlockSlotWindow
 * @param {Object} block - Target block
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyBlockSlotWindow = (slots, blockSlotWindow, block, result) => {
	const currentApplicationSlot = slots.getSlotNumber();
	const blockSlot = slots.getSlotNumber(block.timestamp);

	// Reject block if it's slot is older than BLOCK_SLOT_WINDOW
	if (currentApplicationSlot - blockSlot > blockSlotWindow) {
		result.errors.push(new Error('Block slot is too old'));
	}

	// Reject block if it's slot is in the future
	if (currentApplicationSlot < blockSlot) {
		result.errors.push(new Error('Block slot is in the future'));
	}

	return result;
};

/**
 * Verify block before fork detection and return all possible errors related to block.
 *
 * @param {Object} block - Full block
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyReceipt = ({
	slots,
	blockSlotWindow,
	maxTransactionsPerBlock,
	maxPayloadLength,
	blockReward,
	lastNBlockIds,
	exceptions,
	block,
	lastBlock,
}) => {
	block = blocksUtils.setHeight(block, lastBlock);

	let result = { verified: false, errors: [] };

	result = verifySignature(block, result);
	result = verifyPreviousBlock(block, result);
	result = verifyAgainstLastNBlockIds(block, lastNBlockIds, result);
	result = verifyBlockSlotWindow(slots, blockSlotWindow, block, result);
	result = verifyVersion(block, exceptions, result);
	result = verifyReward(blockReward, block, exceptions, result);
	result = verifyId(block, result);
	result = verifyPayload(
		block,
		maxTransactionsPerBlock,
		maxPayloadLength,
		result
	);

	result.verified = result.errors.length === 0;
	result.errors.reverse();

	return result;
};

/**
 * Verify block before processing and return all possible errors related to block.
 *
 * @param {Object} block - Full block
 * @returns {Object} result - Verification results
 * @returns {boolean} result.verified - Indicator that verification passed
 * @returns {Array} result.errors - Array of validation errors
 */
const verifyBlock = ({
	slots,
	roundsModule,
	maxTransactionsPerBlock,
	maxPayloadLength,
	blockReward,
	exceptions,
	block,
	lastBlock,
}) => {
	block = blocksUtils.setHeight(block, lastBlock);

	let result = { verified: false, errors: [] };

	result = verifySignature(block, result);
	result = verifyPreviousBlock(block, result);
	result = verifyVersion(block, exceptions, result);
	result = verifyReward(blockReward, block, exceptions, result);
	result = verifyId(block, result);
	result = verifyPayload(
		block,
		maxTransactionsPerBlock,
		maxPayloadLength,
		result
	);

	result = verifyForkOne(roundsModule, block, lastBlock, result);
	result = verifyBlockSlot(slots, block, lastBlock, result);

	result.verified = result.errors.length === 0;
	result.errors.reverse();

	return result;
};

const isSaneBlock = (block, lastBlock) =>
	block.previousBlock === lastBlock.id && lastBlock.height + 1 === block.height;

const isForkOne = (block, lastBlock) =>
	block.previousBlock !== lastBlock.id && lastBlock.height + 1 === block.height;

const shouldDiscardForkOne = (block, lastBlock) =>
	block.timestamp > lastBlock.timestamp ||
	(block.timestamp === lastBlock.timestamp && block.id > lastBlock.id);

const isForkFive = (block, lastBlock) =>
	block.previousBlock === lastBlock.previousBlock &&
	block.height === lastBlock.height &&
	block.id !== lastBlock.id;

const isDoubleForge = (block, lastBlock) =>
	block.generatorPublicKey === lastBlock.generatorPublicKey;

const shouldDiscardForkFive = (block, lastBlock) =>
	block.timestamp > lastBlock.timestamp ||
	(block.timestamp === lastBlock.timestamp && block.id > lastBlock.id);

const matchGenesisBlock = (ownGenesisBlock, targetGenesisBlock) =>
	targetGenesisBlock.id === ownGenesisBlock.id &&
	targetGenesisBlock.payloadHash.toString('hex') ===
		ownGenesisBlock.payloadHash &&
	targetGenesisBlock.blockSignature.toString('hex') ===
		ownGenesisBlock.blockSignature;

const reloadRequired = async (storage, slots, blocksCount, memRounds) => {
	const round = slots.calcRound(blocksCount);
	const unapplied = memRounds.filter(row => row.round !== round);
	if (unapplied.length > 0) {
		throw new Error('Detected unapplied rounds in mem_round');
	}
	const accounts = await storage.entities.Account.get(
		{ isDelegate: true },
		{ limit: null }
	);
	const delegatesPublicKeys = accounts.map(account => account.publicKey);
	if (delegatesPublicKeys.length === 0) {
		throw new Error('No delegates found');
	}
};

const requireBlockRewind = async ({
	storage,
	slots,
	transactionManager,
	genesisBlock,
	currentBlock,
	roundsModule,
	maxTransactionsPerBlock,
	maxPayloadLength,
	blockReward,
	exceptions,
}) => {
	const currentHeight = currentBlock.height;
	const currentRound = slots.calcRound(currentHeight);
	const secondLastRound = currentRound - 2;
	const validateTillHeight =
		secondLastRound < 1 ? 2 : slots.calcRoundEndHeight(secondLastRound);
	const secondLastBlock = await blocksUtils.loadBlockByHeight(
		storage,
		currentHeight - 1,
		transactionManager,
		genesisBlock
	);
	const currentBlockResult = verifyBlock({
		block: currentBlock,
		lastBlock: secondLastBlock,
		slots,
		roundsModule,
		maxTransactionsPerBlock,
		maxPayloadLength,
		blockReward,
		exceptions,
	});
	if (currentBlockResult.verified) {
		return false;
	}
	const startBlock = await blocksUtils.loadBlockByHeight(
		storage,
		validateTillHeight,
		transactionManager,
		genesisBlock
	);
	const startBlockLastBlock = await blocksUtils.loadBlockByHeight(
		storage,
		startBlock.height - 1,
		transactionManager,
		genesisBlock
	);
	const startBlockResult = verifyBlock({
		block: startBlock,
		lastBlock: startBlockLastBlock,
		slots,
		roundsModule,
		maxTransactionsPerBlock,
		maxPayloadLength,
		blockReward,
		exceptions,
	});
	if (!startBlockResult.verified) {
		throw new Error(
			`There are more than ${currentHeight -
				validateTillHeight} invalid blocks. Can't delete those to recover the chain.`
		);
	}
	return true;
};

const normalizeAndVerify = async ({
	block,
	exceptions,
	roundsModule,
	slots,
	blockSlotWindow,
	maxTransactionsPerBlock,
	maxPayloadLength,
	blockReward,
	lastNBlockIds,
	lastBlock,
}) => {
	const normalizedBlock = blocksLogic.objectNormalize(block, exceptions);
	await validateBlockSlot(roundsModule, normalizedBlock);
	return verifyReceipt({
		block: normalizedBlock,
		exceptions,
		slots,
		blockSlotWindow,
		maxTransactionsPerBlock,
		maxPayloadLength,
		blockReward,
		lastNBlockIds,
		lastBlock,
	});
};

module.exports = {
	checkExists,
	checkTransactions,
	validateBlockSlot,
	verifySignature,
	verifyBlockSlotWindow,
	verifyPreviousBlock,
	verifyBlockSlot,
	verifyForkOne,
	verifyAgainstLastNBlockIds,
	verifyVersion,
	verifyReward,
	verifyReceipt,
	verifyBlock,
	normalizeAndVerify,
	isSaneBlock,
	isForkOne,
	shouldDiscardForkOne,
	isForkFive,
	shouldDiscardForkFive,
	isDoubleForge,
	matchGenesisBlock,
	reloadRequired,
	requireBlockRewind,
};
