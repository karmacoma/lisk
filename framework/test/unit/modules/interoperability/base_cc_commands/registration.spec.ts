/*
 * Copyright © 2022 Lisk Foundation
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

import { codec } from '@liskhq/lisk-codec';
import { utils } from '@liskhq/lisk-cryptography';
import { MainchainInteroperabilityModule } from '../../../../../src';
import {
	CCM_STATUS_OK,
	CCM_STATUS_CODE_FAILED_CCM,
	CROSS_CHAIN_COMMAND_NAME_REGISTRATION,
	MAINCHAIN_ID_BUFFER,
	MODULE_NAME_INTEROPERABILITY,
	HASH_LENGTH,
	CHAIN_ACTIVE,
} from '../../../../../src/modules/interoperability/constants';
import { MainchainCCRegistrationCommand } from '../../../../../src/modules/interoperability/mainchain/cc_commands';
import { MainchainInteroperabilityInternalMethod } from '../../../../../src/modules/interoperability/mainchain/store';
import { registrationCCMParamsSchema } from '../../../../../src/modules/interoperability/schemas';
import { CCCommandExecuteContext, CCMsg } from '../../../../../src/modules/interoperability/types';
import { NamedRegistry } from '../../../../../src/modules/named_registry';
import { createExecuteCCMsgMethodContext } from '../../../../../src/testing';
import { ChannelDataStore } from '../../../../../src/modules/interoperability/stores/channel_data';
import { OwnChainAccountStore } from '../../../../../src/modules/interoperability/stores/own_chain_account';
import { ChainAccountStore } from '../../../../../src/modules/interoperability/stores/chain_account';
import { CHAIN_ID_LENGTH } from '../../../../../src/modules/token/constants';
import { ChainAccountUpdatedEvent } from '../../../../../src/modules/interoperability/events/chain_account_updated';

describe('BaseCCRegistrationCommand', () => {
	const interopMod = new MainchainInteroperabilityModule();

	const terminateChainInternalMock = jest.fn();
	const channelStoreMock = {
		get: jest.fn(),
		set: jest.fn(),
		has: jest.fn(),
	};
	const ownChainAccountStoreMock = {
		get: jest.fn(),
		set: jest.fn(),
		has: jest.fn(),
	};
	const chainAccountStoreMock = {
		get: jest.fn(),
		set: jest.fn(),
		has: jest.fn(),
	};
	const chainAccountUpdatedEvent = {
		log: jest.fn(),
	};

	const ownChainAccount = {
		name: 'mainchain',
		chainID: MAINCHAIN_ID_BUFFER,
		nonce: BigInt(0),
	};

	const SIDECHAIN_ID_BUFFER = utils.intToBuffer(2, 4);

	const messageFeeTokenID = Buffer.from('0000000000000011', 'hex');
	const ccmRegistrationParams = {
		chainID: SIDECHAIN_ID_BUFFER,
		name: ownChainAccount.name,
		messageFeeTokenID,
	};

	const encodedRegistrationParams = codec.encode(
		registrationCCMParamsSchema,
		ccmRegistrationParams,
	);

	const channelData = {
		inbox: {
			appendPath: [],
			root: Buffer.alloc(0),
			size: 0,
		},
		messageFeeTokenID,
		outbox: {
			appendPath: [],
			root: Buffer.alloc(0),
			size: 1,
		},
		partnerChainOutboxRoot: Buffer.alloc(0),
	};

	const chainAccount = {
		name: 'account1',
		chainID: Buffer.alloc(CHAIN_ID_LENGTH),
		lastCertificate: {
			height: 567467,
			timestamp: 1234,
			stateRoot: Buffer.alloc(HASH_LENGTH),
			validatorsHash: Buffer.alloc(HASH_LENGTH),
		},
		status: 2739,
	};

	const buildCCM = (obj: Partial<CCMsg>) => ({
		crossChainCommand: obj.crossChainCommand ?? CROSS_CHAIN_COMMAND_NAME_REGISTRATION,
		fee: obj.fee ?? BigInt(0),
		module: obj.module ?? MODULE_NAME_INTEROPERABILITY,
		nonce: obj.nonce ?? BigInt(0),
		params: obj.params ?? encodedRegistrationParams,
		receivingChainID: obj.receivingChainID ?? MAINCHAIN_ID_BUFFER,
		sendingChainID: obj.sendingChainID ?? SIDECHAIN_ID_BUFFER,
		status: obj.status ?? CCM_STATUS_OK,
	});

	const resetContext = (ccm: CCMsg): CCCommandExecuteContext => {
		return createExecuteCCMsgMethodContext({
			ccm,
			chainID: SIDECHAIN_ID_BUFFER,
		});
	};

	let ccm: CCMsg;
	let sampleExecuteContext: CCCommandExecuteContext;

	let mainchainInteroperabilityInternalMethod: MainchainInteroperabilityInternalMethod;
	let ccRegistrationCommand: MainchainCCRegistrationCommand;

	beforeEach(() => {
		ccm = buildCCM({});
		sampleExecuteContext = resetContext(ccm);
		mainchainInteroperabilityInternalMethod = new MainchainInteroperabilityInternalMethod(
			interopMod.stores,
			new NamedRegistry(),
			sampleExecuteContext,
			new Map(),
		);
		mainchainInteroperabilityInternalMethod.terminateChainInternal = terminateChainInternalMock;

		interopMod.stores.register(ChannelDataStore, channelStoreMock as never);
		interopMod.stores.register(OwnChainAccountStore, ownChainAccountStoreMock as never);
		interopMod.stores.register(ChainAccountStore, chainAccountStoreMock as never);
		interopMod.events.register(ChainAccountUpdatedEvent, chainAccountUpdatedEvent as never);

		ccRegistrationCommand = new MainchainCCRegistrationCommand(
			interopMod.stores,
			interopMod.events,
			new Map(),
		);
		(ccRegistrationCommand as any)['getInteroperabilityStore'] = jest
			.fn()
			.mockReturnValue(mainchainInteroperabilityInternalMethod);
		channelStoreMock.get.mockResolvedValue(channelData);
		ownChainAccountStoreMock.get.mockResolvedValue(ownChainAccount);
		chainAccountStoreMock.get.mockResolvedValue(chainAccount);
	});

	describe('verify', () => {
		it('should fail if channel.inbox.size != 0', async () => {
			channelStoreMock.get.mockResolvedValue({
				inbox: {
					size: 123,
				},
			});
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).rejects.toThrow(
				'Registration message must be the first message in the inbox.',
			);
		});

		it('should fail if ccm.status != CCM_STATUS_OK', async () => {
			sampleExecuteContext = resetContext(
				buildCCM({
					status: CCM_STATUS_CODE_FAILED_CCM,
				}),
			);
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).rejects.toThrow(
				'Registration message must have status OK.',
			);
		});

		it('should fail if ownChainAccount.chainID != ccm.receivingChainID', async () => {
			sampleExecuteContext = resetContext(
				buildCCM({
					receivingChainID: Buffer.from('1000', 'hex'),
				}),
			);
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).rejects.toThrow(
				'Registration message must be sent to the chain account ID of the chain.',
			);
		});

		it('should fail if ownChainAccount.name != ccmRegistrationParams.name', async () => {
			sampleExecuteContext = resetContext(
				buildCCM({
					params: codec.encode(registrationCCMParamsSchema, {
						chainID: SIDECHAIN_ID_BUFFER,
						name: 'Fake-Name',
						messageFeeTokenID: Buffer.from('0000000000000011', 'hex'),
					}),
				}),
			);
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).rejects.toThrow(
				'Registration message must contain the name of the registered chain.',
			);
		});

		it('should fail if channel.messageFeeTokenID != ccmRegistrationParams.messageFeeTokenID', async () => {
			sampleExecuteContext = resetContext(
				buildCCM({
					params: codec.encode(registrationCCMParamsSchema, {
						chainID: SIDECHAIN_ID_BUFFER,
						name: ownChainAccount.name,
						messageFeeTokenID: Buffer.from('0000000000000012', 'hex'),
					}),
				}),
			);
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).rejects.toThrow(
				'Registration message must contain the same message fee token ID as the chain account.',
			);
		});

		it('should fail if chainID is Mainchain and nonce != 0', async () => {
			sampleExecuteContext = resetContext(
				buildCCM({
					nonce: BigInt(1),
				}),
			);
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).rejects.toThrow(
				'Registration message must have nonce 0.',
			);
		});

		it('should fail if chainID is Sidechain and sendingChainID != CHAIN_ID_MAINCHAIN', async () => {
			sampleExecuteContext = resetContext(
				buildCCM({
					receivingChainID: SIDECHAIN_ID_BUFFER,
				}),
			);
			ownChainAccountStoreMock.get.mockResolvedValue({
				name: 'mainchain',
				chainID: SIDECHAIN_ID_BUFFER,
				nonce: BigInt(0),
			});
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).rejects.toThrow(
				'Registration message must be sent from the mainchain.',
			);
		});

		it('should pass verify when all checks are fulfilled', async () => {
			await expect(ccRegistrationCommand.verify(sampleExecuteContext)).resolves.not.toThrow();
		});
	});
	describe('execute', () => {
		it('should execute successfully', async () => {
			await ccRegistrationCommand.execute(sampleExecuteContext);

			chainAccount.status = CHAIN_ACTIVE;

			expect(chainAccountStoreMock.set).toHaveBeenCalledTimes(1);
			expect(chainAccountUpdatedEvent.log).toHaveBeenCalledWith(
				sampleExecuteContext,
				ccm.sendingChainID,
				chainAccount,
			);
		});
	});
});
