/*
 * Copyright © 2019 Lisk Foundation
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
 *
 */
// tslint:disable-next-line no-require-imports
import shuffle = require('lodash.shuffle');

import {
	DEFAULT_NEW_BUCKET_COUNT,
	DEFAULT_NEW_BUCKET_SIZE,
	DEFAULT_TRIED_BUCKET_COUNT,
	DEFAULT_TRIED_BUCKET_SIZE,
} from '../constants';
import { ExistingPeerError } from '../errors';
import { P2PBasicPeerInfo, P2PPeerInfo } from '../p2p_types';
import { PEER_TYPE } from '../utils';

import { NewList, NewListConfig } from './new_list';
import { TriedList, TriedListConfig } from './tried_list';

export interface PeerBookConfig {
	readonly newListConfig?: NewListConfig;
	readonly triedListConfig?: TriedListConfig;
	readonly secret: number;
}

export class PeerBook {
	private readonly _newPeers: NewList;
	private readonly _triedPeers: TriedList;
	public constructor({
		newListConfig: newListConfig,
		triedListConfig: triedListConfig,
		secret,
	}: PeerBookConfig) {
		this._newPeers = new NewList(
			newListConfig
				? newListConfig
				: {
						secret,
						peerBucketCount: DEFAULT_NEW_BUCKET_COUNT,
						peerBucketSize: DEFAULT_NEW_BUCKET_SIZE,
						peerType: PEER_TYPE.NEW_PEER,
				  },
		);
		this._triedPeers = new TriedList(
			triedListConfig
				? triedListConfig
				: {
						secret,
						peerBucketCount: DEFAULT_TRIED_BUCKET_COUNT,
						peerBucketSize: DEFAULT_TRIED_BUCKET_SIZE,
						peerType: PEER_TYPE.TRIED_PEER,
				  },
		);
	}

	public get newPeers(): ReadonlyArray<P2PPeerInfo> {
		return this._newPeers.peerList;
	}

	public get triedPeers(): ReadonlyArray<P2PPeerInfo> {
		return this._triedPeers.peerList;
	}

	public get allPeers(): ReadonlyArray<P2PPeerInfo> {
		return [...this.newPeers, ...this.triedPeers];
	}

	public getRandomizedPeerList(
		minimumPeerDiscoveryThreshold: number,
		peerDiscoveryResponseLength: number,
	): ReadonlyArray<P2PPeerInfo> {
		const allPeers = [...this.newPeers, ...this.triedPeers];

		/* tslint:disable no-magic-numbers*/
		const min = Math.ceil(
			Math.min(peerDiscoveryResponseLength, allPeers.length * 0.25),
		);
		const max = Math.floor(
			Math.min(peerDiscoveryResponseLength, allPeers.length * 0.5),
		);

		const random = Math.floor(Math.random() * (max - min + 1) + min);
		const randomPeerCount = Math.max(
			random,
			Math.min(minimumPeerDiscoveryThreshold, allPeers.length),
		);

		return shuffle(allPeers).slice(0, randomPeerCount);
	}

	public getPeer(basicPeerInfo: P2PBasicPeerInfo): P2PPeerInfo | undefined {
		const triedPeer = this._triedPeers.getPeer(basicPeerInfo);
		if (this._triedPeers.getPeer(basicPeerInfo)) {
			return triedPeer;
		}

		return this._newPeers.getPeer(basicPeerInfo);
	}

	public addPeer(peerInfo: P2PPeerInfo): void {
		if (this._triedPeers.getPeer(peerInfo)) {
			throw new ExistingPeerError(peerInfo);
		}

		this._newPeers.addPeer(peerInfo);
	}

	public updatePeer(peerInfo: P2PPeerInfo): boolean {
		if (this._triedPeers.getPeer(peerInfo)) {
			return this._triedPeers.updatePeer(peerInfo);
		}

		if (this._newPeers.getPeer(peerInfo)) {
			return this._newPeers.updatePeer(peerInfo);
		}

		return false;
	}

	public removePeer(basicPeerInfo: P2PBasicPeerInfo): boolean {
		if (this._triedPeers.getPeer(basicPeerInfo)) {
			return this._triedPeers.removePeer(basicPeerInfo);
		}

		if (this._newPeers.getPeer(basicPeerInfo)) {
			return this._newPeers.removePeer(basicPeerInfo);
		}

		return false;
	}

	// Move a peer from newList to triedList on events like on successful connection.
	public upgradePeer(peerInfo: P2PPeerInfo): boolean {
		if (this._triedPeers.getPeer(peerInfo)) {
			return true;
		}

		if (this._newPeers.getPeer(peerInfo)) {
			this._newPeers.removePeer(peerInfo);
			this._triedPeers.addPeer(peerInfo);

			return true;
		}

		return false;
	}

	/**
	 * Description: When a peer is downgraded for some reasons then new/triedPeers will trigger their failedConnectionAction,
	 * if the peer is deleted from newList that means the peer is completely deleted from the peer lists and need to inform the calling entity by returning true.
	 */
	public downgradePeer(peerInfo: P2PPeerInfo): boolean {
		if (this._newPeers.getPeer(peerInfo)) {
			if (this._newPeers.failedConnectionAction(peerInfo)) {
				return true;
			}
		}

		if (this._triedPeers.getPeer(peerInfo)) {
			const failed = this._triedPeers.failedConnectionAction(peerInfo);
			if (failed) {
				this.addPeer(peerInfo);
			}
		}

		return false;
	}
}
