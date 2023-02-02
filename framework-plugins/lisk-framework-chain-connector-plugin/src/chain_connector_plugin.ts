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

import {
	BasePlugin,
	PluginInitContext,
	apiClient,
	BFTHeights,
	db as liskDB,
	codec,
	chain,
	OutboxRootWitness,
	JSONObject,
	Schema,
	OwnChainAccountJSON,
	Transaction,
	LastCertificate,
	CcmSendSuccessEventData,
	CcmProcessedEventData,
	CCMProcessedResult,
	CrossChainUpdateTransactionParams,
	certificateSchema,
	ccuParamsSchema,
	cryptography,
	ChainAccountJSON,
	ActiveValidatorsUpdate,
	AggregateCommit,
	Certificate,
} from 'lisk-sdk';
import { calculateActiveValidatorsUpdate } from './active_validators_update';
import { getNextCertificateFromAggregateCommits } from './certificate_generation';
import {
	CCU_FREQUENCY,
	MODULE_NAME_INTEROPERABILITY,
	CCM_SEND_SUCCESS,
	COMMAND_NAME_SUBMIT_SIDECHAIN_CCU,
	CCM_PROCESSED,
	EMPTY_BYTES,
	COMMAND_NAME_SUBMIT_MAINCHAIN_CCU,
} from './constants';
import { ChainConnectorStore, getDBInstance } from './db';
import { Endpoint } from './endpoint';
import { configSchema } from './schemas';
import {
	ChainConnectorPluginConfig,
	SentCCUs,
	BlockHeader,
	ProveResponseJSON,
	BFTParametersJSON,
	ValidatorsData,
} from './types';
import { calculateInboxUpdate, calculateInboxUpdateForPartialUpdate } from './inbox_update';
import {
	bftParametersJSONToObj,
	chainAccountDataJSONToObj,
	getMainchainID,
	proveResponseJSONToObj,
} from './utils';

const { address, ed, encrypt } = cryptography;

interface Data {
	readonly blockHeader: chain.BlockHeaderJSON;
}

type ModuleMetadata = [
	{
		stores: { key: string; data: Schema }[];
		events: { name: string; data: Schema }[];
		name: string;
	},
];

export class ChainConnectorPlugin extends BasePlugin<ChainConnectorPluginConfig> {
	public endpoint = new Endpoint();
	public configSchema = configSchema;
	private _chainConnectorPluginDB!: liskDB.Database;
	private _chainConnectorStore!: ChainConnectorStore;
	private _lastCertificate!: LastCertificate;
	private _ccuFrequency!: number;
	private _maxCCUSize!: number;
	private _saveCCM!: boolean;
	private _receivingChainClient!: apiClient.APIClient;
	private _sendingChainClient!: apiClient.APIClient;
	private _ownChainID!: Buffer;
	private _isReceivingChainIsMainchain!: boolean;
	private readonly _sentCCUs: SentCCUs = [];
	private _privateKey!: Buffer;

	public get nodeModulePath(): string {
		return __filename;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	public async init(context: PluginInitContext): Promise<void> {
		await super.init(context);
		this.endpoint.init(this._sentCCUs);
		this._ccuFrequency = this.config.ccuFrequency ?? CCU_FREQUENCY;
		this._maxCCUSize = this.config.maxCCUSize;
		this._saveCCM = this.config.saveCCM;
		const { password, encryptedPrivateKey } = this.config;
		if (password) {
			const parsedEncryptedKey = encrypt.parseEncryptedMessage(encryptedPrivateKey);
			this._privateKey = await encrypt.decryptMessageWithPassword(parsedEncryptedKey, password);
		}
	}

	public async load(): Promise<void> {
		this._chainConnectorPluginDB = await getDBInstance(this.dataPath);
		this._chainConnectorStore = new ChainConnectorStore(this._chainConnectorPluginDB);
		this.endpoint.load(this._chainConnectorStore);

		if (this.config.receivingChainIPCPath) {
			this._receivingChainClient = await apiClient.createIPCClient(
				this.config.receivingChainIPCPath,
			);
		} else if (this.config.receivingChainWsURL) {
			this._receivingChainClient = await apiClient.createWSClient(this.config.receivingChainWsURL);
		} else {
			throw new Error('IPC path and WS url are undefined.');
		}

		this._sendingChainClient = this.apiClient;

		this._ownChainID = Buffer.from(
			(
				await this._sendingChainClient.invoke<OwnChainAccountJSON>(
					'interoperability_getOwnChainAccount',
				)
			).chainID,
			'hex',
		);
		// If the running node is mainchain then receiving chain will be sidehchain or vice verse.
		this._isReceivingChainIsMainchain = !getMainchainID(this._ownChainID).equals(this._ownChainID);
		// Fetch last certificate from the receiving chain and update the _lastCertificate
		const chainAccountJSON = await this._receivingChainClient.invoke<ChainAccountJSON>(
			'interoperability_getChainAccount',
			{ chainID: this._ownChainID.toString('hex') },
		);
		this._lastCertificate = chainAccountDataJSONToObj(chainAccountJSON).lastCertificate;
		// On a new block start with CCU creation process
		this._sendingChainClient.subscribe('chain_newBlock', async (data?: Record<string, unknown>) =>
			this._newBlockHandler(data),
		);

		this._sendingChainClient.subscribe(
			'chain_deleteBlock',
			async (data?: Record<string, unknown>) => this._deleteBlockHandler(data),
		);
	}

	public async unload(): Promise<void> {
		await this._receivingChainClient.disconnect();
		if (this._sendingChainClient) {
			await this._sendingChainClient.disconnect();
		}

		this._chainConnectorStore.close();
	}

	private async _newBlockHandler(data?: Record<string, unknown>) {
		const { blockHeader: receivedBlock } = data as unknown as Data;

		const newBlockHeader = chain.BlockHeader.fromJSON(receivedBlock).toObject();
		// Save blockHeader, aggregateCommit, validatorsData and cross chain messages if any.
		try {
			const { aggregateCommits, blockHeaders, validatorsHashPreimage } =
				await this._saveDataOnNewBlock(newBlockHeader);

			// When all the relevant data is saved successfully then try to create CCU
			if (this._ccuFrequency >= newBlockHeader.height - this._lastCertificate.height) {
				const newCertificate = await this._findNextCertificate(
					aggregateCommits,
					blockHeaders,
					validatorsHashPreimage,
				);

				if (!newCertificate) {
					const crossChainMessages = await this._chainConnectorStore.getCrossChainMessages();
					/**
					 * If no lastSentCCM then assume that its the first CCM to be sent
					 * and we can use the lastCertificate height
					 * which will be zero in case if this is the first CCU after registration
					 */
					const lastSentCCM = (await this._chainConnectorStore.getLastSentCCM()) ?? {
						nonce: BigInt(0),
						height: this._lastCertificate.height,
					};
					const inboxUpdate = await calculateInboxUpdateForPartialUpdate(
						this._lastCertificate,
						crossChainMessages,
						this._chainConnectorPluginDB,
						lastSentCCM,
						this._maxCCUSize,
					);

					// Send partial update
					await this._submitCCUs([
						codec.encode(ccuParamsSchema, {
							sendingChainID: this._ownChainID,
							activeValidatorsUpdate: {
								bftWeightsUpdate: [],
								blsKeysUpdate: [],
								bftWeightsUpdateBitmap: EMPTY_BYTES,
							},
							certificate: EMPTY_BYTES,
							certificateThreshold: BigInt(0),
							inboxUpdate,
						} as CrossChainUpdateTransactionParams),
					]);
				} else {
					const ccuParamsList = await this._calculateCCUParams(
						newCertificate,
						blockHeaders,
						validatorsHashPreimage,
					);
					if (ccuParamsList) {
						await this._submitCCUs([ccuParamsList]);
					} else {
						this.logger.info(`No CCU was sent for the new block at height ${receivedBlock.height}`);
					}
				}
				// If the transaction is successfully sent then update the last certfied height and do the cleanup
				const chainAccountJSON = await this._receivingChainClient.invoke<ChainAccountJSON>(
					'interoperability_getChainAccount',
					{ chainID: this._ownChainID },
				);
				this._lastCertificate = chainAccountDataJSONToObj(chainAccountJSON).lastCertificate;
				await this._cleanup();
			}
		} catch (error) {
			this.logger.error(error, 'Failed while handling the new block');
		}
	}

	private async _saveDataOnNewBlock(newBlockHeader: BlockHeader) {
		// Save block header if a new block header arrives
		const blockHeaders = await this._chainConnectorStore.getBlockHeaders();

		const blockHeaderIndex = blockHeaders.findIndex(
			header => header.height === newBlockHeader.height,
		);
		if (blockHeaderIndex > -1) {
			blockHeaders[blockHeaderIndex] = newBlockHeader;
		} else {
			blockHeaders.push(newBlockHeader);
		}

		// Check for events if any and store them
		const events = await this._sendingChainClient.invoke<JSONObject<chain.EventAttr[]>>(
			'chain_getEvents',
			{ height: newBlockHeader.height },
		);

		// eslint-disable-next-line no-restricted-syntax, no-labels
		ccmInEventsCheck: if (events && events.length > 0) {
			const ccmSendSuccessEvents = events.filter(
				eventAttr =>
					eventAttr.name === CCM_SEND_SUCCESS && eventAttr.module === MODULE_NAME_INTEROPERABILITY,
			);

			const ccmProcessedEvents = events.filter(
				eventAttr =>
					eventAttr.name === CCM_PROCESSED && eventAttr.module === MODULE_NAME_INTEROPERABILITY,
			);

			if (ccmSendSuccessEvents.length === 0 && ccmProcessedEvents.length === 0) {
				// If there are no CCMs present in the events for the height then skip CCM saving part
				// eslint-disable-next-line no-labels
				break ccmInEventsCheck;
			}

			const { modules } = await this._sendingChainClient.invoke<{ modules: ModuleMetadata }>(
				'system_getMetadata',
			);
			const interoperabilityMetadata = modules.find(m => m.name === MODULE_NAME_INTEROPERABILITY);

			if (!interoperabilityMetadata) {
				throw new Error('No metadata found for interoperability module.');
			}
			const ccmsFromEvents = [];
			// Save ccm send success events
			if (ccmSendSuccessEvents.length > 0) {
				const ccmSendSuccessEventInfo = interoperabilityMetadata.events.filter(
					e => e.name === CCM_SEND_SUCCESS,
				);

				if (!ccmSendSuccessEventInfo?.[0]?.data) {
					throw new Error('No schema found for "ccmSendSuccess" event data.');
				}

				for (const e of ccmSendSuccessEvents) {
					const eventData = codec.decode<CcmSendSuccessEventData>(
						ccmSendSuccessEventInfo[0].data,
						Buffer.from(e.data, 'hex'),
					);
					ccmsFromEvents.push(eventData.ccm);
				}
			}
			// Save ccm processed events based on CCMProcessedResult FORWARDED = 1
			if (ccmProcessedEvents.length > 0) {
				const ccmProcessedEventInfo = interoperabilityMetadata.events.filter(
					e => e.name === CCM_PROCESSED,
				);

				if (!ccmProcessedEventInfo?.[0]?.data) {
					throw new Error('No schema found for "ccmProcessed" event data.');
				}

				for (const e of ccmProcessedEvents) {
					const eventData = codec.decode<CcmProcessedEventData>(
						ccmProcessedEventInfo[0].data,
						Buffer.from(e.data, 'hex'),
					);
					if (eventData.result === CCMProcessedResult.FORWARDED) {
						ccmsFromEvents.push(eventData.ccm);
					}
				}
			}

			// TODO: find a better way to find storeKey from metadata
			const store = interoperabilityMetadata.stores.find(
				s => s.data.$id === '/modules/interoperability/outbox',
			);

			// Calculate the inclusion proof of the CCMs
			const outboxKey = Buffer.concat([Buffer.from(store?.key as string, 'hex'), this._ownChainID]);
			const proveResponseJSON = await this._sendingChainClient.invoke<ProveResponseJSON>(
				'state_prove',
				{
					queries: [outboxKey],
				},
			);
			const proveResponseObj = proveResponseJSONToObj(proveResponseJSON);
			const inclusionProofOutboxRoot: OutboxRootWitness = {
				bitmap: proveResponseObj.proof.queries[0].bitmap,
				siblingHashes: proveResponseObj.proof.siblingHashes,
			};
			const crossChainMessages = await this._chainConnectorStore.getCrossChainMessages();
			crossChainMessages.push({
				ccms: ccmsFromEvents,
				height: newBlockHeader.height,
				inclusionProof: inclusionProofOutboxRoot,
			});

			await this._chainConnectorStore.setCrossChainMessages(crossChainMessages);
		}

		// Save validatorsData for a new validatorsHash
		const validatorsHashPreimage = await this._chainConnectorStore.getValidatorsHashPreimage();

		// Get validatorsData at new block header height
		const bftParametersJSON = await this._sendingChainClient.invoke<BFTParametersJSON>(
			'consensus_getBFTParameters',
			{ height: newBlockHeader.height },
		);

		const bftParametersObj = bftParametersJSONToObj(bftParametersJSON);
		const validatorsDataIndex = validatorsHashPreimage.findIndex(v =>
			v.validatorsHash.equals(bftParametersObj.validatorsHash),
		);
		// Save validatorsData if there is a new validatorsHash
		if (validatorsDataIndex === -1) {
			validatorsHashPreimage.push({
				certificateThreshold: bftParametersObj.certificateThreshold,
				validators: bftParametersObj.validators,
				validatorsHash: bftParametersObj.validatorsHash,
			});
		}

		// Save aggregateCommit if present in the block header
		const aggregateCommits = await this._chainConnectorStore.getAggregateCommits();
		if (newBlockHeader.aggregateCommit) {
			const aggregateCommitIndex = aggregateCommits.findIndex(
				commit => commit.height === newBlockHeader.aggregateCommit.height,
			);
			if (aggregateCommitIndex > -1) {
				aggregateCommits[aggregateCommitIndex] = newBlockHeader.aggregateCommit;
			} else {
				aggregateCommits.push(newBlockHeader.aggregateCommit);
			}
		}

		// Save all the data
		await this._chainConnectorStore.setBlockHeaders(blockHeaders);
		await this._chainConnectorStore.setAggregateCommits(aggregateCommits);
		await this._chainConnectorStore.setValidatorsHashPreimage(validatorsHashPreimage);

		return {
			blockHeaders,
			aggregateCommits,
			validatorsHashPreimage,
		};
	}

	private async _findNextCertificate(
		aggregateCommits: AggregateCommit[],
		blockHeaders: BlockHeader[],
		validatorsHashPreimage: ValidatorsData[],
	) {
		const bftHeights = await this._sendingChainClient.invoke<BFTHeights>('consensus_getBFTHeights');
		// Calculate certificate
		const certificate = getNextCertificateFromAggregateCommits(
			blockHeaders,
			aggregateCommits,
			validatorsHashPreimage,
			bftHeights,
			this._lastCertificate,
		);

		return certificate;
	}

	/**
	 * @see https://github.com/LiskHQ/lips/blob/main/proposals/lip-0053.md#parameters
	 */
	public async _calculateCCUParams(
		certificate: Certificate,
		blockHeaders: BlockHeader[],
		validatorsHashPreimage: ValidatorsData[],
	): Promise<Buffer | undefined> {
		const lastSentCCM = await this._chainConnectorStore.getLastSentCCM();
		const crossChainMessages = await this._chainConnectorStore.getCrossChainMessages();

		// Calculate activeValidatorsUpdate
		let activeValidatorsUpdate: ActiveValidatorsUpdate = {
			blsKeysUpdate: [],
			bftWeightsUpdate: [],
			bftWeightsUpdateBitmap: Buffer.from([]),
		};
		let certificateThreshold = BigInt(0);

		const blockHeader = blockHeaders.find(header => header.height === certificate.height);
		if (!blockHeader) {
			throw new Error('No block header found for the given certificate height.');
		}

		if (!this._lastCertificate.validatorsHash.equals(certificate.validatorsHash)) {
			const validatorsUpdateResult = calculateActiveValidatorsUpdate(
				certificate,
				validatorsHashPreimage,
				this._lastCertificate,
			);
			activeValidatorsUpdate = validatorsUpdateResult.activeValidatorsUpdate;
			certificateThreshold = validatorsUpdateResult.certificateThreshold;
		}
		// Calculate inboxUpdate
		const inboxUpdate = await calculateInboxUpdate(
			certificate,
			crossChainMessages,
			this._chainConnectorPluginDB,
			// If no lastSentCCM then assume that we can start from the beginning
			lastSentCCM ?? { height: 1, nonce: BigInt(-1) },
			this._maxCCUSize,
		);
		const serializedCertificate = codec.encode(certificateSchema, certificate);

		return codec.encode(ccuParamsSchema, {
			sendingChainID: this._ownChainID,
			activeValidatorsUpdate,
			certificate: serializedCertificate,
			certificateThreshold,
			inboxUpdate,
		} as CrossChainUpdateTransactionParams);
	}

	private async _deleteBlockHandler(data?: Record<string, unknown>) {
		const { blockHeader: receivedBlock } = data as unknown as Data;

		const newBlockHeader = chain.BlockHeader.fromJSON(receivedBlock).toObject();

		const findIndexByHeight = (someData: { height: number }[]): number =>
			someData.findIndex(datum => datum.height === newBlockHeader.height);

		const blockHeaders = await this._chainConnectorStore.getBlockHeaders();
		const blockHeaderIndex = findIndexByHeight(blockHeaders);
		if (blockHeaderIndex !== -1) {
			blockHeaders.splice(blockHeaderIndex, 1);
			await this._chainConnectorStore.setBlockHeaders(blockHeaders);
		}

		const aggregateCommits = await this._chainConnectorStore.getAggregateCommits();
		const aggregateCommitIndex = findIndexByHeight(aggregateCommits);
		if (aggregateCommitIndex !== -1) {
			aggregateCommits.splice(aggregateCommitIndex, 1);
			await this._chainConnectorStore.setAggregateCommits(aggregateCommits);
		}

		const validatorsHashPreimage = await this._chainConnectorStore.getValidatorsHashPreimage();
		const validatorsHashPreimageIndex = validatorsHashPreimage.findIndex(v =>
			v.validatorsHash.equals(newBlockHeader.validatorsHash),
		);
		if (validatorsHashPreimageIndex !== -1) {
			validatorsHashPreimage.splice(validatorsHashPreimageIndex, 1);
			await this._chainConnectorStore.setValidatorsHashPreimage(validatorsHashPreimage);
		}
	}

	private async _cleanup() {
		// Delete CCMs
		const crossChainMessages = await this._chainConnectorStore.getCrossChainMessages();
		const index = crossChainMessages.findIndex(ccm => ccm.height === this._lastCertificate.height);
		crossChainMessages.splice(index, 1);

		await this._chainConnectorStore.setCrossChainMessages(crossChainMessages);

		// Delete blockHeaders
		const blockHeaders = await this._chainConnectorStore.getBlockHeaders();

		await this._chainConnectorStore.setBlockHeaders(
			blockHeaders.filter(blockHeader => blockHeader.height >= this._lastCertificate.height),
		);

		// Delete aggregateCommits
		const aggregateCommits = await this._chainConnectorStore.getAggregateCommits();

		await this._chainConnectorStore.setAggregateCommits(
			aggregateCommits.filter(
				aggregateCommit => aggregateCommit.height >= this._lastCertificate.height,
			),
		);
		// Delete validatorsHashPreimage
		const validatorsHashPreimage = await this._chainConnectorStore.getValidatorsHashPreimage();

		await this._chainConnectorStore.setValidatorsHashPreimage(
			validatorsHashPreimage.filter(
				validatorsData =>
					validatorsData.certificateThreshold >= BigInt(this._lastCertificate.height),
			),
		);
	}

	private async _submitCCUs(ccuParams: Buffer[]): Promise<void> {
		const activeAPIClient = this._receivingChainClient;
		const activePrivateKey = this._privateKey;
		const activePublicKey = ed.getPublicKeyFromPrivateKey(activePrivateKey);
		const activeTargetCommand = this._isReceivingChainIsMainchain
			? COMMAND_NAME_SUBMIT_MAINCHAIN_CCU
			: COMMAND_NAME_SUBMIT_SIDECHAIN_CCU;

		const { nonce } = await activeAPIClient.invoke<{ nonce: string }>('auth_getAuthAccount', {
			address: address.getLisk32AddressFromPublicKey(activePublicKey),
		});

		const { chainID: chainIDStr } = await activeAPIClient.invoke<{ chainID: string }>(
			'system_getNodeInfo',
		);
		const chainID = Buffer.from(chainIDStr, 'hex');

		for (let i = 0; i < ccuParams.length; i += 1) {
			const tx = new Transaction({
				module: MODULE_NAME_INTEROPERABILITY,
				command: activeTargetCommand,
				nonce: BigInt(nonce) + BigInt(i),
				senderPublicKey: activePublicKey,
				fee: BigInt(this.config.ccuFee),
				params: ccuParams[i],
				signatures: [],
			});
			tx.sign(chainID, activePrivateKey);
			let result: { transactionId: string };
			if (this._saveCCM) {
				result = { transactionId: tx.id.toString('hex') };
			} else {
				result = await activeAPIClient.invoke<{
					transactionId: string;
				}>('txpool_postTransaction', {
					transaction: tx.getBytes().toString('hex'),
				});
			}
			/**
			 * TODO: As of now we save it in memory but going forward it should be saved in DB,
			 * as the array size can grow after sometime.
			 */
			this._sentCCUs.push(tx);
			this.logger.info({ transactionID: result.transactionId }, 'Sent CCU transaction');
		}
	}
}
