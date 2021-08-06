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
 */

export interface BlockRewardOptions {
	readonly distance: number;
	readonly rewardOffset: number;
	readonly milestones: ReadonlyArray<bigint>;
}

export interface RawBlock {
	header: Buffer;
	payload: ReadonlyArray<Buffer>;
}

export interface DiffHistory {
	code: string;
	line: number;
}

export interface StateDiff {
	readonly updated: Array<Readonly<UpdatedDiff>>;
	readonly created: Array<Buffer>;
	readonly deleted: Array<Readonly<UpdatedDiff>>;
}

export interface UpdatedDiff {
	readonly key: Buffer;
	readonly value: Buffer;
}
