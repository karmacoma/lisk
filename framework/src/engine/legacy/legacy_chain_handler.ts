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
import { P2PRequestPacket } from '@liskhq/lisk-p2p/dist-node/types';
import { Database, NotFoundError } from '@liskhq/lisk-db';
import { LegacyConfig } from '../../types';
import { Network } from '../network';
import { getBlocksFromIdRequestSchema, getBlocksFromIdResponseSchema } from '../consensus/schema';
import { Storage } from './storage';
import { LegacyBlock, LegacyBlockBracket, Peer } from './types';
import { decodeBlock, encodeBlockHeader } from './codec';
import { PeerNotFoundWithLegacyInfo } from './errors';
import { validateLegacyBlock } from './validate';
import { Logger } from '../../logger';

interface LegacyChainHandlerArgs {
	legacyConfig: LegacyConfig;
	network: Network;
	logger: Logger;
}

interface LegacyHandlerInitArgs {
	db: Database;
}

export class LegacyChainHandler {
	private readonly _network: Network;
	private _storage!: Storage;
	private readonly _legacyConfig: LegacyConfig;
	private readonly _logger: Logger;
	private _syncTimeout!: NodeJS.Timeout;

	public constructor(args: LegacyChainHandlerArgs) {
		this._legacyConfig = args.legacyConfig;
		this._network = args.network;
		this._logger = args.logger;
	}

	public async init(args: LegacyHandlerInitArgs): Promise<void> {
		this._storage = new Storage(args.db);

		for (const bracket of this._legacyConfig.brackets) {
			try {
				const bracketStorageKey = Buffer.from(bracket.snapshotBlockID, 'hex');
				const bracketExists = await this._storage.legacyChainBracketInfoExist(bracketStorageKey);

				if (!bracketExists) {
					await this._storage.setLegacyChainBracketInfo(bracketStorageKey, {
						startHeight: bracket.startHeight,
						snapshotBlockHeight: bracket.snapshotHeight,
						// if start block already exists then assign to lastBlockHeight
						lastBlockHeight: bracket.snapshotHeight,
					});
					continue;
				}

				const storedBracketInfo = await this._storage.getLegacyChainBracketInfo(bracketStorageKey);
				const startBlock = await this._storage.getBlockByHeight(bracket.startHeight);

				// In case a user wants to indirectly update the bracketInfo stored in legacyDB
				await this._storage.setLegacyChainBracketInfo(bracketStorageKey, {
					...storedBracketInfo,
					startHeight: bracket.startHeight,
					snapshotBlockHeight: bracket.snapshotHeight,
					// if start block already exists then assign to lastBlockHeight
					lastBlockHeight: startBlock ? bracket.startHeight : bracket.snapshotHeight,
				});
			} catch (error) {
				if (!(error instanceof NotFoundError)) {
					throw error;
				}
			}
		}
	}

	public async sync() {
		for (const bracket of this._legacyConfig.brackets) {
			const bracketInfo = await this._storage.getLegacyChainBracketInfo(
				Buffer.from(bracket.snapshotBlockID, 'hex'),
			);

			// means this bracket is already synced/parsed (in next `syncBlocks` step)
			if (bracket.startHeight === bracketInfo.lastBlockHeight) {
				continue;
			}
			let lastBlockID;
			try {
				const lastBlock = decodeBlock(
					await this._storage.getBlockByHeight(bracketInfo.lastBlockHeight),
				).block;
				lastBlockID = lastBlock.header.id;
			} catch (error) {
				if (!(error instanceof NotFoundError)) {
					throw error;
				}
				// If lastBlock does not exist then sync from the beginning
				lastBlockID = Buffer.from(bracket.snapshotBlockID, 'hex');
			}

			// start parsing bracket from `lastBlock` height`
			await this._trySyncBlocks(bracket, lastBlockID);
		}

		// when ALL brackets are synced/parsed, finally update node with it's `legacy` property
		this._network.applyNodeInfo({
			legacy: this._legacyConfig.brackets.map(bracket =>
				Buffer.from(bracket.snapshotBlockID, 'hex'),
			),
		});

		clearTimeout(this._syncTimeout);
	}

	private async _trySyncBlocks(bracket: LegacyBlockBracket, lastBlockID: Buffer) {
		try {
			await this.syncBlocks(bracket, lastBlockID);
		} catch (err) {
			if (err instanceof PeerNotFoundWithLegacyInfo) {
				// eslint-disable-next-line @typescript-eslint/no-misused-promises
				this._syncTimeout = setTimeout(async () => {
					await this._trySyncBlocks(bracket, lastBlockID);
				}, 120000); // 2 mints = (60 * 2) * 1000
			} else {
				throw err;
			}
		}
	}

	/**
	 * Flow of syncing legacy blocks
	 *
	 * Check if we have `sync` property `true` in configuration (already done in engine.ts)
	 * call getConnectedPeers from network
	 * Filter peers having their `legacy` buffer array contains `snapshotBlockID`
	 * If there is no peer, throw error, this error will be used in outside function to retry calling `syncBlocks` after x amount of time
	 * Get a random peer from list of filtered peers with legacy info
	 * Make a request to that random peer by calling its `getLegacyBlocksFromId` method with `data` property set to `legacyBlock.header.id`
	 * Try to decode response data buffer using getBlocksFromIdResponseSchema, apply penalty in case of error & retry syncBlocks
	 * Validate `blocks: Buffer[]`, apply penalty in case of error & retry syncBlocks
	 * Decode `blocks: Buffer[]` into LegacyBlock[] & start saving one by one
	 * If last block height is still higher than bracket.startHeight, save bracket with `lastBlockHeight: lastBlock?.header.height` & repeat syncBlocks
	 * If last block height equals bracket.startHeight, simply save bracket with `lastBlockHeight: lastBlock?.header.height`
	 */
	// eslint-disable-next-line @typescript-eslint/member-ordering
	public async syncBlocks(bracket: LegacyBlockBracket, lastBlockID: Buffer): Promise<void> {
		const connectedPeers = this._network.getConnectedPeers() as unknown as Peer[];
		const peersWithLegacyInfo = connectedPeers.filter(
			peer =>
				!!(peer.options as { legacy: Buffer[] }).legacy.find(snapshotBlockID =>
					snapshotBlockID.equals(Buffer.from(bracket.snapshotBlockID, 'hex')),
				),
		);
		if (peersWithLegacyInfo.length === 0) {
			throw new PeerNotFoundWithLegacyInfo('No peer found with legacy info.');
		}

		const randomPeerIndex = Math.trunc(Math.random() * peersWithLegacyInfo.length - 1);
		const { peerId } = peersWithLegacyInfo[randomPeerIndex];

		const requestData = codec.encode(getBlocksFromIdRequestSchema, {
			blockID: lastBlockID,
			snapshotBlockID: Buffer.from(bracket.snapshotBlockID, 'hex'),
		});
		const p2PRequestPacket: P2PRequestPacket = {
			procedure: 'getLegacyBlocksFromId',
			data: requestData,
		};

		const response = await this._network.requestFromPeer({ ...p2PRequestPacket, peerId });

		// `data` is expected to hold blocks in DESC order
		const { data } = response;
		let legacyBlocks: LegacyBlock[];

		const applyPenaltyAndRepeat = async (msg: string) => {
			this._logger.warn({ peerId }, `${msg}: Applying a penalty to the peer`);
			this._network.applyPenaltyOnPeer({ peerId, penalty: 100 });
			await this.syncBlocks(bracket, lastBlockID);
		};

		try {
			// this part is needed to make sure `data` returns ONLY `{ blocks: Buffer[] }` & not any extra field(s)
			const { blocks } = codec.decode<{ blocks: Buffer[] }>(
				getBlocksFromIdResponseSchema,
				data as Buffer,
			);
			if (blocks.length === 0) {
				await applyPenaltyAndRepeat('Received empty response');
			}

			this._applyValidation(blocks);

			legacyBlocks = blocks.map(block => decodeBlock(block).block);
			if (legacyBlocks.length === 0) {
				await applyPenaltyAndRepeat('received empty blocks');
			}
		} catch (err) {
			await applyPenaltyAndRepeat((err as Error).message); // catch validation error
		}

		// @ts-expect-error Variable 'legacyBlocks' is used before being assigned.
		for (const block of legacyBlocks) {
			if (block.header.height > bracket.startHeight) {
				const payload = block.payload.length ? block.payload : [];
				await this._storage.saveBlock(
					block.header.id as Buffer,
					block.header.height,
					encodeBlockHeader(block.header),
					payload,
				);
			}
		}

		// @ts-expect-error Variable 'legacyBlocks' is used before being assigned.
		const lastBlock = legacyBlocks[legacyBlocks.length - 1];
		if (lastBlock && lastBlock.header.height > bracket.startHeight) {
			await this._updateBracketInfo(lastBlock, bracket);
			await this.syncBlocks(bracket, lastBlockID);
		}

		await this._updateBracketInfo(lastBlock, bracket);
	}

	private async _updateBracketInfo(lastBlock: LegacyBlock, bracket: LegacyBlockBracket) {
		await this._storage.setLegacyChainBracketInfo(Buffer.from(bracket.snapshotBlockID, 'hex'), {
			startHeight: bracket.startHeight,
			lastBlockHeight: lastBlock?.header.height,
			snapshotBlockHeight: bracket.snapshotHeight,
		});
	}

	private _applyValidation(blocks: Buffer[]) {
		const sortedBlocks = [];
		for (let i = blocks.length - 1; i >= 0; i -= 1) {
			sortedBlocks.push(blocks[i]);
		}

		const sortedLegacyBlocks = sortedBlocks.map(block => decodeBlock(block).block);

		sortedBlocks.forEach((block, index) => {
			if (index < sortedBlocks.length - 1) {
				// skip the last block, since we don't have its next block available yet
				validateLegacyBlock(block, sortedLegacyBlocks[index + 1]);
			}
		});
	}
}
