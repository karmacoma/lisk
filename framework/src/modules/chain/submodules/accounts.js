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

const { getAddressFromPublicKey } = require('@liskhq/lisk-cryptography');
const async = require('async');
const BlockReward = require('../logic/block_reward.js');

// Private fields
let modules;
let library;
let self;
const __private = {};

__private.assetTypes = {};

/**
 * Main accounts methods. Initializes library with scope content and generates a Vote instance.
 *
 * @class
 * @memberof modules
 * @see Parent: {@link modules}
 * @requires helpers/bignum
 * @requires logic/block_reward
 * @param {scope} scope - App instance
 * @param {function} cb - Callback function
 * @returns {setImmediateCallback} cb, null, self
 */

class Accounts {
	constructor(cb, scope) {
		library = {
			storage: scope.components.storage,
			logger: scope.components.logger,
			schema: scope.schema,
			balancesSequence: scope.balancesSequence,
			logic: {
				account: scope.logic.account,
			},
		};
		self = this;
		__private.blockReward = new BlockReward();

		setImmediate(cb, null, self);
	}

	/**
	 * Gets account information, calls logic.account.get().
	 *
	 * @param {Object} filter - Contains public key
	 * @param {function} fields - Fields to get
	 * @param {function} cb - Callback function
	 */
	// eslint-disable-next-line class-methods-use-this
	getAccount(filter, fields, cb, tx) {
		if (filter.publicKey) {
			filter.address = getAddressFromPublicKey(filter.publicKey);
			delete filter.publicKey;
		}

		library.logic.account.get(filter, fields, cb, tx);
	}

	/**
	 * Gets accounts information, calls logic.account.getAll().
	 *
	 * @param {Object} filter
	 * @param {Object} fields
	 * @param {function} cb - Callback function
	 * @param {Object} tx - Database transaction/task object
	 * @todo Add description for the params
	 */
	// eslint-disable-next-line class-methods-use-this
	getAccounts(filter, fields, cb, tx) {
		library.logic.account.getAll(filter, fields, cb, tx);
	}

	/**
	 * Validates input address and calls logic.account.set() and logic.account.get().
	 *
	 * @param {Object} data - Contains address or public key to generate address
	 * @param {function} cb - Callback function
	 * @returns {setImmediateCallback} cb, err
	 * @returns {function} Call to logic.account.get()
	 */
	// eslint-disable-next-line class-methods-use-this
	setAccountAndGet(data, cb, tx) {
		let address = data.address || null;
		let err;

		if (address === null) {
			if (data.publicKey) {
				address = getAddressFromPublicKey(data.publicKey);
			} else {
				err = new Error('Missing address or public key');
			}
		}

		if (!address) {
			err = new Error('Invalid public key');
		}

		if (err) {
			if (typeof cb === 'function') {
				return setImmediate(cb, err);
			}
			throw err;
		}

		const task = t =>
			new Promise((resolve, reject) => {
				async.waterfall(
					[
						waterfallCb => {
							library.logic.account.set(
								address,
								data,
								setAccountErr => {
									if (setAccountErr) {
										library.logger.error(
											`Set account ${address} failed`,
											setAccountErr
										);
										return setImmediate(waterfallCb, setAccountErr);
									}
									return setImmediate(waterfallCb);
								},
								t
							);
						},
						waterfallCb => {
							library.logic.account.get(
								{ address },
								(getAccountErr, account) => {
									if (getAccountErr) {
										library.logger.error(
											`Get account ${address} failed`,
											getAccountErr
										);
										return setImmediate(waterfallCb, getAccountErr);
									}
									return setImmediate(waterfallCb, null, account);
								},
								t
							);
						},
					],
					(waterfallErr, account) => {
						if (waterfallErr) {
							return reject(waterfallErr);
						}
						return resolve(account);
					}
				);
			});

		// Force task to run in a db tx to make sure it always return the inserted account
		const taskPromise = tx
			? task(tx)
			: library.storage.entities.Account.begin(
					'Accounts:setAccountAndGet',
					task
			  );

		return taskPromise
			.then(taskPromiseData => setImmediate(cb, null, taskPromiseData))
			.catch(taskPromiseErr => setImmediate(cb, taskPromiseErr));
	}

	/**
	 * Validates input address and calls logic.account.merge().
	 *
	 * @param {Object} data - Contains address and public key
	 * @param {function} cb - Callback function
	 * @returns {setImmediateCallback} cb, err
	 * @returns {function} Calls to logic.account.merge()
	 * @todo Improve public key validation try/catch
	 */
	// eslint-disable-next-line class-methods-use-this
	mergeAccountAndGet(data, cb, tx) {
		let address = data.address || null;
		let err;

		if (address === null) {
			if (data.publicKey) {
				address = getAddressFromPublicKey(data.publicKey);
			} else {
				err = new Error('Missing address or public key');
			}
		}

		if (!address) {
			err = new Error('Invalid public key');
		}

		if (err) {
			if (typeof cb === 'function') {
				return setImmediate(cb, err);
			}
			throw err;
		}

		return library.logic.account.merge(address, data, cb, tx);
	}

	// Events
	/**
	 * Calls Vote.bind() with scope.
	 *
	 * @param {modules} scopedModules - Loaded modules
	 */
	// eslint-disable-next-line class-methods-use-this
	onBind(scope) {
		modules = {
			transactions: scope.modules.transactions,
			blocks: scope.modules.blocks,
			rounds: scope.modules.rounds,
		};

		library.logic.account.bind(modules);
	}

	/**
	 * Checks if modules is loaded.
	 *
	 * @returns {boolean} True if modules is loaded
	 */
	// eslint-disable-next-line class-methods-use-this
	isLoaded() {
		return !!modules;
	}
}

// Export
module.exports = Accounts;
