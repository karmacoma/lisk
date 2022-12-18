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
	Certificate,
	BFTHeights,
	db as liskDB,
	codec,
	chain,
	BFTParameters,
	LIVENESS_LIMIT,
	ChainAccount,
	OutboxRootWitness,
	MESSAGE_TAG_CERTIFICATE,
	ActiveValidator,
	certificateSchema,
	cryptography,
	ccmSchema,
	JSONObject,
	ChainStatus,
	Schema,
	OwnChainAccountJSON,
	LastCertificate,
	LastCertificateJSON,
	CcmSendSuccessEventData,
	CcmProcessedEventData,
	CCMProcessedResult,
} from 'lisk-sdk';
import { getNextCertificateFromAggregateCommits } from './certificate_generation';
import {
	LIVENESS_BASED_CCU_FREQUENCY,
	MODULE_NAME_INTEROPERABILITY,
	CCM_SEND_SUCCESS,
	DB_KEY_SIDECHAIN,
	CCM_PROCESSED,
} from './constants';
import { ChainConnectorStore, getDBInstance } from './db';
import { Endpoint } from './endpoint';
import { configSchema } from './schemas';
import {
	ChainConnectorPluginConfig,
	SentCCUs,
	CrossChainUpdateTransactionParams,
	InboxUpdate,
	ProveResponse,
	BlockHeader,
} from './types';
import { getActiveValidatorsDiff } from './utils';

interface Data {
	readonly blockHeader: chain.BlockHeaderJSON;
}

interface LivenessValidationResult {
	status: boolean;
	isLive: boolean;
	chainID: Buffer;
	certificateTimestamp: number;
	blockTimestamp: number;
}

interface CertificateValidationResult {
	status: boolean;
	livenessValidationResult?: LivenessValidationResult;
	chainStatus: number;
	certificate: Certificate;
	header: BlockHeader;
	hasValidBLSWeightedAggSig?: boolean;
	message: string;
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
	private _sidechainChainConnectorDB!: ChainConnectorStore;
	private _lastCertificate!: LastCertificate;
	private _ccuFrequency!: number;
	private _mainchainAPIClient!: apiClient.APIClient;
	private _sidechainAPIClient!: apiClient.APIClient;
	private _ownChainID!: Buffer;
	private readonly _sentCCUs: SentCCUs = [];

	public get nodeModulePath(): string {
		return __filename;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	public async init(context: PluginInitContext): Promise<void> {
		await super.init(context);
		this.endpoint.init(this._sentCCUs);
		this._ccuFrequency = this.config.livenessBasedFrequency ?? LIVENESS_BASED_CCU_FREQUENCY;
	}

	public async load(): Promise<void> {
		this._chainConnectorPluginDB = await getDBInstance(this.dataPath);
		this._sidechainChainConnectorDB = new ChainConnectorStore(
			this._chainConnectorPluginDB,
			DB_KEY_SIDECHAIN,
		);
		this.endpoint.load(this._sidechainChainConnectorDB);

		this._mainchainAPIClient = await apiClient.createIPCClient(this.config.mainchainIPCPath);
		if (this.config.sidechainIPCPath) {
			this._sidechainAPIClient = await apiClient.createIPCClient(this.config.sidechainIPCPath);
		} else {
			this._sidechainAPIClient = this.apiClient;
		}
		// TODO: After DB issue we need to fetch the last sent CCUs and assign it to _sentCCUs
		// eslint-disable-next-line no-console
		console.log(this._sentCCUs);
		// TODO: Fetch the certificate height from last sent CCU and update the height

		// TODO: CCM should be collected and stored via events
		if (this._sidechainAPIClient) {
			this._ownChainID = Buffer.from(
				(
					await this._sidechainAPIClient.invoke<OwnChainAccountJSON>(
						'interoperability_getOwnChainAccount',
					)
				).chainID,
				'hex',
			);
			// Fetch last certificate from the receiving chain and update the _lastCertificate
			const lastCertificate = await this._mainchainAPIClient.invoke<LastCertificateJSON>(
				'interoperability_getChainAccount',
				{ chainID: this._ownChainID },
			);
			this._lastCertificate = {
				height: lastCertificate.height,
				stateRoot: Buffer.from(lastCertificate.stateRoot, 'hex'),
				timestamp: lastCertificate.timestamp,
				validatorsHash: Buffer.from(lastCertificate.validatorsHash, 'hex'),
			};
			// On a new block start with CCU creation process
			this._sidechainAPIClient.subscribe('chain_newBlock', async (data?: Record<string, unknown>) =>
				this._newBlockHandler(data),
			);
		}
	}

	private async _newBlockHandler(data?: Record<string, unknown>) {
		const { blockHeader: receivedBlock } = data as unknown as Data;
		const newBlockHeader = chain.BlockHeader.fromJSON(receivedBlock).toObject();
		// Save block header, aggregateCommit, validatorsData and cross chain messages if any.
		try {
			await this._saveDataOnNewBlock(newBlockHeader);
		} catch (error) {
			this.logger.error(error, 'Failed during saving data on new block event.');

			return;
		}

		// When all the relevant data is saved successfully then try to create CCU
		// When # of CCMs are there on the outbox to be sent or # of blocks passed from last certified height
		if (this._ccuFrequency >= newBlockHeader.height - this._lastCertificate.height) {
			// TODO: _createCCU needs to be implemented which will create and send the CCU transaction
			await this._createCCU();
			// if the transaction is successfully submitted then update the last certfied height and do the cleanup
			// TODO: also check if the state is growing, delete everything from the inMemory state if it goes beyond last 3 rounds
			await this._cleanup();
		}
	}

	private async _saveDataOnNewBlock(newBlockHeader: BlockHeader) {
		// Save blockheader if a new block header
		const blockHeaders = await this._sidechainChainConnectorDB.getBlockHeaders();

		const indexBlockHeader = blockHeaders.findIndex(
			header => header.height === newBlockHeader.height,
		);
		if (indexBlockHeader > -1) {
			blockHeaders[indexBlockHeader] = newBlockHeader;
		} else {
			blockHeaders.push(newBlockHeader);
		}

		// Check for events if any and store them
		const events = await this._sidechainAPIClient.invoke<JSONObject<chain.EventAttr[]>>(
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

			const { modules } = await this._sidechainAPIClient.invoke<{ modules: ModuleMetadata }>(
				'system_getMetadata',
			);
			const interoperabilityMetadata = modules.find(m => m.name === MODULE_NAME_INTEROPERABILITY);

			const ccmsFromEvents = [];
			// Save ccm send success events
			if (ccmSendSuccessEvents.length > 0) {
				const ccmSendSuccessEventInfo = interoperabilityMetadata?.events.filter(
					e => e.name === 'ccmSendSuccess',
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
				const ccmProcessedEventInfo = interoperabilityMetadata?.events.filter(
					e => e.name === 'ccmProcessed',
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
			const store = interoperabilityMetadata?.stores.find(
				s => s.data.$id === '/modules/interoperability/outbox',
			);

			// Calculate the inclusion proof of the CCMs
			const outboxKey = Buffer.concat([Buffer.from(store?.key as string, 'hex'), this._ownChainID]);
			const stateProveResponse = await this._sidechainAPIClient.invoke<ProveResponse>(
				'state_prove',
				{
					queries: [outboxKey],
				},
			);
			const inclusionProofOutboxRoot: OutboxRootWitness = {
				bitmap: stateProveResponse.proof.queries[0].bitmap,
				siblingHashes: stateProveResponse.proof.siblingHashes,
			};
			const crossChainMessages = await this._sidechainChainConnectorDB.getCrossChainMessages();
			crossChainMessages.push({
				ccms: ccmsFromEvents,
				height: newBlockHeader.height,
				inclusionProof: inclusionProofOutboxRoot,
			});

			await this._sidechainChainConnectorDB.setCrossChainMessages(crossChainMessages);
		}

		// Save validatorsData for a new validatorsHash
		const validatorsHashPreimages =
			await this._sidechainChainConnectorDB.getValidatorsHashPreImage();

		// Get validatorsData at new block header height
		const bftParameters = await this._sidechainAPIClient.invoke<BFTParameters>(
			'consensus_getBFTParameters',
			{ height: newBlockHeader.height },
		);
		const indexValidatorsData = validatorsHashPreimages.findIndex(v =>
			v.validatorsHash.equals(bftParameters?.validatorsHash),
		);
		// Save validatorsData if there is a new validatorsHash
		if (indexValidatorsData === -1) {
			validatorsHashPreimages.push({
				certificateThreshold: bftParameters?.certificateThreshold,
				validators: bftParameters?.validators,
				validatorsHash: bftParameters?.validatorsHash,
			});
		}

		// Save aggregateCommit if present in the block header
		const aggregateCommits = await this._sidechainChainConnectorDB.getAggregateCommits();
		if (newBlockHeader.aggregateCommit) {
			const indexAggregateCommit = aggregateCommits.findIndex(
				commit => commit.height === newBlockHeader.aggregateCommit.height,
			);
			if (indexAggregateCommit > -1) {
				aggregateCommits[indexAggregateCommit] = newBlockHeader.aggregateCommit;
			} else {
				aggregateCommits.push(newBlockHeader.aggregateCommit);
			}
		}

		// Save all the data
		await this._sidechainChainConnectorDB.setBlockHeaders(blockHeaders);
		await this._sidechainChainConnectorDB.setAggregateCommits(aggregateCommits);
		await this._sidechainChainConnectorDB.setValidatorsHashPreImage(validatorsHashPreimages);
	}

	public async createCCUParams() {
		const blockHeaders = await this._sidechainChainConnectorDB.getBlockHeaders();
		const aggregateCommits = await this._sidechainChainConnectorDB.getAggregateCommits();
		const validatorsHashPreimages =
			await this._sidechainChainConnectorDB.getValidatorsHashPreImage();
		const bftHeights = await this._sidechainAPIClient.invoke<BFTHeights>('consensus_getBFTHeights');
		const certificate = getNextCertificateFromAggregateCommits(
			blockHeaders,
			aggregateCommits,
			validatorsHashPreimages,
			bftHeights,
			this._lastCertificate,
		);
		if (!certificate) {
			throw new Error('No certificate found in the ccu creation process.');
		}
		// Calculate activeValidatorsUpdate
		// Calculate inboxUpdate
	}

	public async unload(): Promise<void> {
		await this._mainchainAPIClient.disconnect();
		if (this._sidechainAPIClient) {
			await this._sidechainAPIClient.disconnect();
		}

		this._sidechainChainConnectorDB.close();
	}

	public async calculateCCUParams(
		sendingChainID: Buffer,
		certificate: Certificate,
		newCertificateThreshold: bigint,
	): Promise<CrossChainUpdateTransactionParams | undefined> {
		let activeBFTValidatorsUpdate: ActiveValidator[];
		let activeValidatorsUpdate: ActiveValidator[] = [];
		let certificateThreshold = newCertificateThreshold;

		const blockHeaders = await this._sidechainChainConnectorDB.getBlockHeaders();

		const blockHeader = blockHeaders.find(header => header.height === certificate.height);

		if (!blockHeader) {
			throw new Error('No block header found for the given certifcate height.');
		}

		const chainAccount = await this._mainchainAPIClient.invoke<ChainAccount>(
			'interoperability_getChainAccount',
			{ chainID: sendingChainID },
		);

		const certificateBytes = codec.encode(certificateSchema, certificate);

		const certificateValidationResult = await this._validateCertificate(
			certificateBytes,
			certificate,
			blockHeader,
			chainAccount,
			sendingChainID,
		);
		if (!certificateValidationResult.status) {
			this.logger.error(certificateValidationResult, 'Certificate validation failed');

			return undefined;
		}

		if (!chainAccount.lastCertificate.validatorsHash.equals(certificate.validatorsHash)) {
			const validatorsHashPreimages =
				await this._sidechainChainConnectorDB.getValidatorsHashPreImage();

			const validatorDataAtCertificate = validatorsHashPreimages.find(data =>
				data.validatorsHash.equals(blockHeader.validatorsHash),
			);

			if (!validatorDataAtCertificate) {
				throw new Error('No validators data at certificate height.');
			}

			const validatorDataAtLastCertificate = validatorsHashPreimages.find(data =>
				data.validatorsHash.equals(chainAccount.lastCertificate.validatorsHash),
			);

			if (!validatorDataAtLastCertificate) {
				throw new Error('No validators data at last certified height.');
			}

			if (
				validatorDataAtCertificate.certificateThreshold ===
				validatorDataAtLastCertificate.certificateThreshold
			) {
				certificateThreshold = BigInt(0);
			}

			activeBFTValidatorsUpdate = getActiveValidatorsDiff(
				validatorDataAtLastCertificate.validators,
				validatorDataAtCertificate.validators,
			);

			activeValidatorsUpdate = activeBFTValidatorsUpdate.map(
				validator =>
					({
						blsKey: validator.blsKey,
						bftWeight: validator.bftWeight,
					} as ActiveValidator),
			);
		}

		const inboxUpdate = await this._calculateInboxUpdate(sendingChainID);

		return {
			sendingChainID,
			certificate: certificateBytes,
			activeValidatorsUpdate,
			certificateThreshold,
			inboxUpdate,
		};
	}

	private async _calculateInboxUpdate(sendingChainID: Buffer): Promise<InboxUpdate> {
		// TODO: Fetch as many CCMs as configured in _ccuFrequency.ccm, between lastCertificateHeight and certificateHeight - After #7569
		const crossChainMessages = await this._sidechainChainConnectorDB.getCrossChainMessages();
		const serialzedCCMs = crossChainMessages.map(ccm => codec.encode(ccmSchema, ccm));

		// TODO: should use the store prefix with sendingChainID after issue https://github.com/LiskHQ/lisk-sdk/issues/7631
		const outboxKey = sendingChainID;

		const stateProveResponse = await this._sidechainAPIClient.invoke<ProveResponse>('state_prove', {
			queries: [outboxKey],
		});
		const inclusionProofOutboxRoot: OutboxRootWitness = {
			bitmap: stateProveResponse.proof.queries[0].bitmap,
			siblingHashes: stateProveResponse.proof.siblingHashes,
		};

		return {
			crossChainMessages: serialzedCCMs,
			messageWitnessHashes: [],
			outboxRootWitness: inclusionProofOutboxRoot,
		};
	}

	private async _validateCertificate(
		certificateBytes: Buffer,
		certificate: Certificate,
		blockHeader: BlockHeader,
		chainAccount: ChainAccount,
		sendingChainID: Buffer,
	): Promise<CertificateValidationResult> {
		const result: CertificateValidationResult = {
			status: false,
			chainStatus: chainAccount.status,
			certificate,
			header: blockHeader,
			message: 'Certificate validation failed.',
		};

		if (chainAccount.status === ChainStatus.TERMINATED) {
			result.message = 'Sending chain is terminated.';
			return result;
		}

		if (certificate.height <= chainAccount.lastCertificate.height) {
			result.message = 'Certificate height is higher than last certified height.';
			return result;
		}

		const certificateLivenessValidationResult = await this._verifyLiveness(
			sendingChainID,
			certificate.timestamp,
			blockHeader.timestamp,
		);

		result.livenessValidationResult = certificateLivenessValidationResult;

		if (!certificateLivenessValidationResult.status) {
			result.message = 'Liveness validation failed.';
			return result;
		}

		if (chainAccount.status === ChainStatus.ACTIVE) {
			result.status = true;

			return result;
		}

		const validatorsHashPreimages =
			await this._sidechainChainConnectorDB.getValidatorsHashPreImage();
		const validatorData = validatorsHashPreimages.find(data =>
			data.validatorsHash.equals(blockHeader.validatorsHash),
		);

		if (!validatorData) {
			result.message = 'Block validators are not valid.';

			return result;
		}

		const keysList = validatorData.validators.map(validator => validator.blsKey);

		const weights = validatorData.validators.map(validator => validator.bftWeight);

		const hasValidWeightedAggSig = cryptography.bls.verifyWeightedAggSig(
			keysList,
			certificate.aggregationBits as Buffer,
			certificate.signature as Buffer,
			MESSAGE_TAG_CERTIFICATE,
			sendingChainID,
			certificateBytes,
			weights,
			validatorData.certificateThreshold,
		);
		if (hasValidWeightedAggSig) {
			result.hasValidBLSWeightedAggSig = true;
			result.status = false;
			return result;
		}

		result.message = 'Weighted aggregate signature is not valid.';

		return result;
	}

	private async _verifyLiveness(
		chainID: Buffer,
		certificateTimestamp: number,
		blockTimestamp: number,
	): Promise<LivenessValidationResult> {
		const isLive = await this._mainchainAPIClient.invoke<boolean>('interoperability_isLive', {
			chainID,
			timestamp: certificateTimestamp,
		});

		const result: LivenessValidationResult = {
			status: true,
			isLive,
			chainID,
			certificateTimestamp,
			blockTimestamp,
		};

		if (isLive && blockTimestamp - certificateTimestamp < LIVENESS_LIMIT / 2) {
			return result;
		}

		result.status = false;

		return result;
	}

	private async _deleteBlockHeaders() {
		const blockHeaders = await this._sidechainChainConnectorDB.getBlockHeaders();

		await this._sidechainChainConnectorDB.setBlockHeaders(
			blockHeaders.filter(blockHeader => blockHeader.height >= this._lastCertificate.height),
		);
	}

	private async _deleteAggregateCommits() {
		const aggregateCommits = await this._sidechainChainConnectorDB.getAggregateCommits();

		await this._sidechainChainConnectorDB.setAggregateCommits(
			aggregateCommits.filter(
				aggregateCommit => aggregateCommit.height >= this._lastCertificate.height,
			),
		);
	}

	private async _deleteValidatorsHashPreimage() {
		const validatorsHashPreimages =
			await this._sidechainChainConnectorDB.getValidatorsHashPreImage();

		await this._sidechainChainConnectorDB.setValidatorsHashPreImage(
			validatorsHashPreimages.filter(
				validatorsHashPreimage =>
					validatorsHashPreimage.certificateThreshold >= BigInt(this._lastCertificate.height),
			),
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-empty-function
	private async _cleanup() {
		const crossChainMessages = await this._sidechainChainConnectorDB.getCrossChainMessages();
		const index = crossChainMessages.findIndex(ccm => ccm.height === this._lastCertificate.height);
		crossChainMessages.splice(index, 1);
		await this._sidechainChainConnectorDB.setCrossChainMessages(crossChainMessages);

		await this._deleteAggregateCommits();
		await this._deleteBlockHeaders();
		await this._deleteValidatorsHashPreimage();
	}

	// eslint-disable-next-line @typescript-eslint/no-empty-function
	private async _createCCU() {}
}
