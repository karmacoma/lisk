/*
 * Copyright © 2021 Lisk Foundation
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

import { BlockHeader } from '@liskhq/lisk-chain';
import { BFTAPI, ValidatorAPI } from '../types';
import { AggregateCommit, CommitPoolConfig, SingleCommit, ValidatorInfo } from './types';

export class CommitPool {
	private readonly _nonGossipedCommits: Map<number, SingleCommit[]> = new Map<
		number,
		SingleCommit[]
	>();
	private readonly _gossipedCommits: Map<number, SingleCommit[]> = new Map<
		number,
		SingleCommit[]
	>();
	private readonly _blockTime: number;
	private readonly _bftAPI: BFTAPI;
	private readonly _validatorsAPI: ValidatorAPI;

	public constructor(config: CommitPoolConfig) {
		this._blockTime = config.blockTime;
		this._bftAPI = config.bftAPI;
		this._validatorsAPI = config.validatorsAPI;
		// eslint-disable-next-line no-console
		console.log(
			this._nonGossipedCommits.size,
			this._gossipedCommits.size,
			this._blockTime,
			this._bftAPI,
			this._validatorsAPI,
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-empty-function
	public job() {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	public addCommit(_commit: SingleCommit, _height: number) {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	public validateCommit() {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	public getCommitsByHeight(_height: number) {}

	public createSingleCommit(
		_blockHeader: BlockHeader,
		_validatorInfo: ValidatorInfo,
		_networkIdentifier: Buffer,
		// eslint-disable-next-line @typescript-eslint/no-empty-function
	) {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	public verifyAggregateCommit(_aggregateCommit: AggregateCommit) {}
	// TODO: To be updated in the issue https://github.com/LiskHQ/lisk-sdk/issues/6846
	public getAggregageCommit() {
		const singleCommits = this._selectAggregateCommit();

		return this._aggregateSingleCommits((singleCommits as unknown) as SingleCommit[]);
	}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	private _aggregateSingleCommits(_singleCommits: SingleCommit[]) {}
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	private _selectAggregateCommit() {}
}
