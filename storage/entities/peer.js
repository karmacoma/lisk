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

const { defaults, omit, pick } = require('lodash');
const filterType = require('../utils/filter_types');
const { stringToByte } = require('../utils/inputSerializers');
const BaseEntity = require('./base_entity');

const defaultCreateValues = {};

const readOnlyFields = [];

/**
 * Peer
 * @typedef {Object} Peer
 * @property {number} id
 * @property {string} ip
 * @property {number} wsPort
 * @property {number} state
 * @property {string} os
 * @property {string} version
 * @property {string} broadhash
 * @property {number} height
 */

/**
 * Peer Filters
 * @typedef {Object} filters.Peer
 * @property {number} [id]
 * @property {number} [id_eql]
 * @property {number} [id_ne]
 * @property {number} [id_gt]
 * @property {number} [id_gte]
 * @property {number} [id_lt]
 * @property {number} [id_lte]
 * @property {number} [id_in]
 * @property {string} [ip]
 * @property {string} [ip_eql]
 * @property {string} [ip_ne]
 * @property {string} [ip_in]
 * @property {string} [ip_like]
 * @property {number} [wsPort]
 * @property {number} [wsPort_eql]
 * @property {number} [wsPort_ne]
 * @property {number} [wsPort_gt]
 * @property {number} [wsPort_gte]
 * @property {number} [wsPort_lt]
 * @property {number} [wsPort_lte]
 * @property {number} [wsPort_in]
 * @property {number} [state]
 * @property {number} [state_eql]
 * @property {number} [state_ne]
 * @property {number} [state_gt]
 * @property {number} [state_gte]
 * @property {number} [state_lt]
 * @property {number} [state_lte]
 * @property {number} [state_in]
 * @property {string} [os]
 * @property {string} [os_eql]
 * @property {string} [os_ne]
 * @property {string} [os_in]
 * @property {string} [os_like]
 * @property {string} [version]
 * @property {string} [version_eql]
 * @property {string} [version_ne]
 * @property {string} [version_in]
 * @property {string} [version_like]
 * @property {string} [broadhash]
 * @property {string} [broadhash_eql]
 * @property {string} [broadhash_ne]
 * @property {string} [broadhash_in]
 * @property {string} [broadhash_like]
 * @property {number} [height]
 * @property {number} [height_eql]
 * @property {number} [height_ne]
 * @property {number} [height_gt]
 * @property {number} [height_gte]
 * @property {number} [height_lt]
 * @property {number} [height_lte]
 * @property {number} [height_in]
 */

class Peer extends BaseEntity {
	/**
	 * Constructor
	 * @param {BaseAdapter} adapter - Adapter to retrieve the data from
	 * @param {filters.Peer} defaultFilters - Set of default filters applied on every query
	 */
	constructor(adapter, defaultFilters = {}) {
		super(adapter, defaultFilters);

		this.addField('id', 'number', { filter: filterType.NUMBER });
		this.addField('ip', 'string', { format: 'ip', filter: filterType.TEXT });
		this.addField('wsPort', 'number', { filter: filterType.NUMBER });
		this.addField('state', 'number', { filter: filterType.NUMBER });
		this.addField('os', 'string', { filter: filterType.TEXT });
		this.addField('version', 'string', { filter: filterType.TEXT });
		this.addField(
			'broadhash',
			'string',
			{ filter: filterType.TEXT },
			stringToByte
		);
		this.addField('height', 'number', { filter: filterType.NUMBER });

		this.SQLs = {
			select: this.adapter.loadSQLFile('peers/get.sql'),
			create: this.adapter.loadSQLFile('peers/create.sql'),
			update: this.adapter.loadSQLFile('peers/update.sql'),
			updateOne: this.adapter.loadSQLFile('peers/update_one.sql'),
			isPersisted: this.adapter.loadSQLFile('peers/is_persisted.sql'),
		};
	}

	/**
	 * Get one peer
	 *
	 * @param {filters.Peer|filters.Peer[]} [filters = {}]
	 * @param {Object} [options = {}] - Options to filter data
	 * @param {Number} [options.limit=10] - Number of records to fetch
	 * @param {Number} [options.offset=0] - Offset to start the records
	 * @param {Object} [tx] - Database transaction object
	 * @return {Promise.<Peer, Error>}
	 */
	getOne(filters, options = {}, tx = null) {
		const expectedResultCount = 1;
		return this._getResults(filters, options, tx, expectedResultCount);
	}

	/**
	 * Get list of peers
	 *
	 * @param {filters.Peer|filters.Peer[]} [filters = {}]
	 * @param {Object} [options = {}] - Options to filter data
	 * @param {Number} [options.limit=10] - Number of records to fetch
	 * @param {Number} [options.offset=0] - Offset to start the records
	 * @param {Object} [tx] - Database transaction object
	 * @return {Promise.<Peer[], Error>}
	 */
	get(filters = {}, options = {}, tx = null) {
		return this._getResults(filters, options, tx);
	}

	_getResults(filters, options, tx, expectedResultCount = undefined) {
		this.validateFilters(filters);
		this.validateOptions(options);

		const mergedFilters = this.mergeFilters(filters);
		const parsedFilters = this.parseFilters(mergedFilters);
		const parsedOptions = defaults(
			{},
			pick(options, ['limit', 'offset']),
			pick(this.defaultOptions, ['limit', 'offset'])
		);

		const params = {
			limit: parsedOptions.limit,
			offset: parsedOptions.offset,
			parsedFilters,
		};

		return this.adapter.executeFile(
			this.SQLs.select,
			params,
			{ expectedResultCount },
			tx
		);
	}

	/**
	 * Create peer object
	 *
	 * @param {Object} data
	 * @param {Object} [_options]
	 * @param {Object} [tx] - Transaction object
	 * @return {null}
	 */
	// eslint-disable-next-line no-unused-vars
	create(data, _options = {}, tx = null) {
		const objectData = defaults(data, defaultCreateValues);
		const createSet = this.getValuesSet(objectData);
		const attributes = Object.keys(data)
			.map(k => `"${this.fields[k].fieldName}"`)
			.join(',');

		return this.adapter.executeFile(
			this.SQLs.create,
			{ createSet, attributes },
			{ expectedResultCount: 0 },
			tx
		);
	}

	/**
	 * Update the records based on given condition
	 *
	 * @param {filters.Peer} [filters]
	 * @param {Object} data
	 * @param {Object} [options]
	 * @param {Object} [tx] - Transaction object
	 * @return {null}
	 */
	update(filters, data, _options, tx = null) {
		this.validateFilters(filters);
		const objectData = omit(data, readOnlyFields);
		const mergedFilters = this.mergeFilters(filters);
		const parsedFilters = this.parseFilters(mergedFilters);
		const updateSet = this.getUpdateSet(objectData);

		const params = {
			...objectData,
			parsedFilters,
			updateSet,
		};

		return this.adapter.executeFile(
			this.SQLs.update,
			params,
			{ expectedResultCount: 0 },
			tx
		);
	}

	/**
	 * Update one record based on the condition given
	 *
	 * @param {filters.Peer} filters
	 * @param {Object} data
	 * @param {Object} [options]
	 * @param {Object} [tx] - Transaction object
	 * @return {null}
	 */
	updateOne(filters, data, _options, tx = null) {
		this.validateFilters(filters);
		const objectData = omit(data, readOnlyFields);
		const mergedFilters = this.mergeFilters(filters);
		const parsedFilters = this.parseFilters(mergedFilters);
		const updateSet = this.getUpdateSet(objectData);

		const params = {
			...objectData,
			parsedFilters,
			updateSet,
		};

		return this.adapter.executeFile(
			this.SQLs.updateOne,
			params,
			{ expectedResultCount: 0 },
			tx
		);
	}

	/**
	 * Check if the record exists with following conditions
	 *
	 * @param {filters.Peer} filters
	 * @param {Object} [options]
	 * @param {Object} [tx]
	 * @returns {Promise.<boolean, Error>}
	 */
	isPersisted(filters, _options, tx = null) {
		const atLeastOneRequired = true;
		this.validateFilters(filters, atLeastOneRequired);
		const mergedFilters = this.mergeFilters(filters);
		const parsedFilters = this.parseFilters(mergedFilters);

		return this.adapter
			.executeFile(
				this.SQLs.isPersisted,
				{ parsedFilters },
				{ expectedResultCount: 1 },
				tx
			)
			.then(result => result.exists);
	}
}

module.exports = Peer;
