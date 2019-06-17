/* eslint-disable mocha/no-pending-tests */
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

const { StorageSandbox } = require('../../../../../../common/storage_sandbox');
const seeder = require('../../../../../../common/storage_seed');
const {
	entities: { BaseEntity },
} = require('../../../../../../../../src/components/storage');
const {
	ChainMeta,
} = require('../../../../../../../../src/modules/chain/components/storage/entities');

describe('ChainMeta', () => {
	let adapter;
	let storage;
	let ChainMetaEntity;

	const validSQLs = ['create', 'update', 'upsert'];

	const validFields = ['key', 'value'];

	const validFilters = ['key', 'key_eql', 'key_ne'];

	before(async () => {
		storage = new StorageSandbox(
			__testContext.config.components.storage,
			'lisk_test_storage_custom_round_chain_module'
		);
		await storage.bootstrap();

		adapter = storage.adapter;
		ChainMetaEntity = storage.entities.ChainMeta;
	});

	afterEach(() => {
		sinonSandbox.restore();
		return seeder.reset(storage);
	});

	it('should be a constructable function', async () => {
		expect(ChainMeta.prototype.constructor).not.to.be.null;
		expect(ChainMeta.prototype.constructor.name).to.be.eql('ChainMeta');
	});

	it('should extend BaseEntity', async () => {
		expect(ChainMeta.prototype instanceof BaseEntity).to.be.true;
	});

	describe('constructor()', () => {
		it('should accept only one mandatory parameter', async () => {
			expect(ChainMeta.prototype.constructor.length).to.be.eql(1);
		});

		it('should have called super', async () => {
			// The reasoning here is that if the parent's contstructor was called
			// the properties from the parent are present in the extending object
			expect(typeof ChainMetaEntity.parseFilters).to.be.eql('function');
			expect(typeof ChainMetaEntity.addFilter).to.be.eql('function');
			expect(typeof ChainMetaEntity.addField).to.be.eql('function');
			expect(typeof ChainMetaEntity.getFilters).to.be.eql('function');
			expect(typeof ChainMetaEntity.getUpdateSet).to.be.eql('function');
			expect(typeof ChainMetaEntity.getValuesSet).to.be.eql('function');
			expect(typeof ChainMetaEntity.begin).to.be.eql('function');
			expect(typeof ChainMetaEntity.validateFilters).to.be.eql('function');
			expect(typeof ChainMetaEntity.validateOptions).to.be.eql('function');
		});

		it('should assign proper sql', async () => {
			expect(ChainMetaEntity.SQLs).to.include.all.keys(validSQLs);
		});

		it('should call addField the exact number of times', async () => {
			const addFieldSpy = sinonSandbox.spy(ChainMeta.prototype, 'addField');
			new ChainMeta(adapter);

			expect(addFieldSpy.callCount).to.eql(
				Object.keys(ChainMetaEntity.fields).length
			);
		});

		it('should setup correct fields', async () => {
			expect(ChainMetaEntity.fields).to.include.all.keys(validFields);
		});

		it('should setup specific filters', async () => {
			expect(ChainMetaEntity.getFilters()).to.be.eql(validFilters);
		});
	});
});
