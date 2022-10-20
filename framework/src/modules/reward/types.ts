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

import { BlockAssets, MethodContext, ImmutableMethodContext } from '../../state_machine';

export interface ModuleConfig {
	tokenID: string;
	brackets: ReadonlyArray<string>;
	offset: number;
	distance: number;
}

export interface TokenMethod {
	mint: (
		methodContext: MethodContext,
		address: Buffer,
		id: Buffer,
		amount: bigint,
	) => Promise<void>;
}

export interface RandomMethod {
	isSeedRevealValid(
		methodContext: ImmutableMethodContext,
		generatorAddress: Buffer,
		assets: BlockAssets,
	): Promise<boolean>;
}

export interface BFTMethod {
	impliesMaximalPrevotes(methodContext: ImmutableMethodContext): Promise<boolean>;
}

export interface DefaultReward {
	reward: string;
}

export interface EndpointInitArgs {
	config: {
		brackets: ReadonlyArray<bigint>;
		offset: number;
		distance: number;
	};
}

export interface MethodInitArgs {
	config: {
		brackets: ReadonlyArray<bigint>;
		offset: number;
		distance: number;
	};
}

export interface CalculateDefaultRewardArgs {
	brackets: ReadonlyArray<bigint>;
	offset: number;
	distance: number;
	height: number;
}
