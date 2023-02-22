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

import { codec, db as liskDB, AggregateCommit, Certificate, chain } from 'lisk-sdk';
import * as os from 'os';
import { join } from 'path';
import { ensureDir } from 'fs-extra';
import {
	DB_KEY_AGGREGATE_COMMITS,
	DB_KEY_BLOCK_HEADERS,
	DB_KEY_CERTIFICATE,
	DB_KEY_CROSS_CHAIN_MESSAGES,
	DB_KEY_LAST_SENT_CCM,
	DB_KEY_LIST_OF_CCU,
	DB_KEY_VALIDATORS_HASH_PREIMAGE,
} from './constants';
import {
	aggregateCommitsInfoSchema,
	blockHeadersInfoSchema,
	ccmsFromEventsSchema,
	certificatesSchema,
	lastSentCCMWithHeight,
	listOfCCUsSchema,
	validatorsHashPreimageInfoSchema,
} from './schemas';
import { BlockHeader, CCMsFromEvents, LastSentCCMWithHeight, ValidatorsData } from './types';

const { Database } = liskDB;
type KVStore = liskDB.Database;

interface BlockHeadersInfo {
	blockHeaders: BlockHeader[];
}

interface AggregateCommitsInfo {
	aggregateCommits: AggregateCommit[];
}

interface ValidatorsHashPreimage {
	validatorsHashPreimage: ValidatorsData[];
}

interface CrossChainMessagesInfo {
	ccmsFromEvents: CCMsFromEvents[];
}

export const getDBInstance = async (
	dataPath: string,
	dbName = 'lisk-framework-chain-connector-plugin.db',
): Promise<KVStore> => {
	const dirPath = join(dataPath.replace('~', os.homedir()), 'plugins/data', dbName);
	await ensureDir(dirPath);

	return new Database(dirPath);
};

export class ChainConnectorStore {
	private readonly _db: KVStore;

	public constructor(db: KVStore) {
		this._db = db;
	}

	public close() {
		this._db.close();
	}

	public async getBlockHeaders(): Promise<BlockHeader[]> {
		let blockHeaders: BlockHeader[] = [];
		try {
			const encodedInfo = await this._db.get(DB_KEY_BLOCK_HEADERS);
			blockHeaders = codec.decode<BlockHeadersInfo>(
				blockHeadersInfoSchema,
				encodedInfo,
			).blockHeaders;
		} catch (error) {
			if (!(error instanceof liskDB.NotFoundError)) {
				throw error;
			}
		}
		return blockHeaders;
	}

	public async setBlockHeaders(blockHeaders: BlockHeader[]) {
		const encodedInfo = codec.encode(blockHeadersInfoSchema, { blockHeaders });

		await this._db.set(DB_KEY_BLOCK_HEADERS, encodedInfo);
	}

	public async getAggregateCommits(): Promise<AggregateCommit[]> {
		let aggregateCommits: AggregateCommit[] = [];
		try {
			const encodedInfo = await this._db.get(DB_KEY_AGGREGATE_COMMITS);
			aggregateCommits = codec.decode<AggregateCommitsInfo>(
				aggregateCommitsInfoSchema,
				encodedInfo,
			).aggregateCommits;
		} catch (error) {
			if (!(error instanceof liskDB.NotFoundError)) {
				throw error;
			}
		}
		return aggregateCommits;
	}

	public async setAggregateCommits(aggregateCommits: AggregateCommit[]) {
		const encodedInfo = codec.encode(aggregateCommitsInfoSchema, { aggregateCommits });
		await this._db.set(DB_KEY_AGGREGATE_COMMITS, encodedInfo);
	}

	public async getValidatorsHashPreimage(): Promise<ValidatorsData[]> {
		let validatorsHashPreimage: ValidatorsData[] = [];
		try {
			const encodedInfo = await this._db.get(DB_KEY_VALIDATORS_HASH_PREIMAGE);
			validatorsHashPreimage = codec.decode<ValidatorsHashPreimage>(
				validatorsHashPreimageInfoSchema,
				encodedInfo,
			).validatorsHashPreimage;
		} catch (error) {
			if (!(error instanceof liskDB.NotFoundError)) {
				throw error;
			}
		}
		return validatorsHashPreimage;
	}

	public async setValidatorsHashPreimage(validatorsHashInput: ValidatorsData[]) {
		const encodedInfo = codec.encode(validatorsHashPreimageInfoSchema, {
			validatorsHashPreimage: validatorsHashInput,
		});
		await this._db.set(DB_KEY_VALIDATORS_HASH_PREIMAGE, encodedInfo);
	}

	public async getCrossChainMessages(): Promise<CCMsFromEvents[]> {
		let crossChainMessages: CCMsFromEvents[] = [];
		try {
			const encodedInfo = await this._db.get(DB_KEY_CROSS_CHAIN_MESSAGES);
			crossChainMessages = codec.decode<CrossChainMessagesInfo>(
				ccmsFromEventsSchema,
				encodedInfo,
			).ccmsFromEvents;
		} catch (error) {
			if (!(error instanceof liskDB.NotFoundError)) {
				throw error;
			}
		}
		return crossChainMessages;
	}

	public async setCrossChainMessages(ccms: CCMsFromEvents[]) {
		const encodedInfo = codec.encode(ccmsFromEventsSchema, { ccmsFromEvents: ccms });
		await this._db.set(DB_KEY_CROSS_CHAIN_MESSAGES, encodedInfo);
	}

	public async getLastSentCCM(): Promise<LastSentCCMWithHeight | undefined> {
		let lastSentCCM: LastSentCCMWithHeight | undefined;
		try {
			const encodedInfo = await this._db.get(DB_KEY_LAST_SENT_CCM);
			lastSentCCM = codec.decode<LastSentCCMWithHeight>(lastSentCCMWithHeight, encodedInfo);
		} catch (error) {
			if (!(error instanceof liskDB.NotFoundError)) {
				throw error;
			}
		}
		return lastSentCCM;
	}

	public async setLastSentCCM(lastSentCCM: LastSentCCMWithHeight) {
		await this._db.set(DB_KEY_LAST_SENT_CCM, codec.encode(lastSentCCMWithHeight, lastSentCCM));
	}

	public async getCertificates(): Promise<Certificate[]> {
		let certificates: Certificate[] = [];
		try {
			const encodedInfo = await this._db.get(DB_KEY_CERTIFICATE);
			certificates = codec.decode<{ certificates: Certificate[] }>(
				certificatesSchema,
				encodedInfo,
			).certificates;
		} catch (error) {
			if (!(error instanceof liskDB.NotFoundError)) {
				throw error;
			}
		}
		return certificates;
	}

	public async setCertificates(certificates: Certificate[]) {
		certificates.sort((a, b) => b.height - a.height);
		await this._db.set(DB_KEY_CERTIFICATE, codec.encode(certificatesSchema, { certificates }));
	}

	public async getListOfCCUs(): Promise<chain.TransactionAttrs[]> {
		let listOfCCUs: chain.TransactionAttrs[] = [];
		try {
			const encodedInfo = await this._db.get(DB_KEY_LIST_OF_CCU);
			listOfCCUs = codec.decode<{ listOfCCUs: chain.TransactionAttrs[] }>(
				listOfCCUsSchema,
				encodedInfo,
			).listOfCCUs;
		} catch (error) {
			if (!(error instanceof liskDB.NotFoundError)) {
				throw error;
			}
		}
		return listOfCCUs;
	}

	public async setListOfCCUs(listOfCCUs: chain.TransactionAttrs[]) {
		listOfCCUs.sort((a, b) => Number(b.nonce) - Number(a.nonce));

		await this._db.set(DB_KEY_LIST_OF_CCU, codec.encode(listOfCCUsSchema, { listOfCCUs }));
	}
}
