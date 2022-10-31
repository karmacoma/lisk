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

import {
	CommandExecuteContext,
	CommandVerifyContext,
	VerificationResult,
	VerifyStatus,
} from '../../../state_machine';
import { BaseCommand } from '../../base_command';
import {
	EMPTY_KEY,
	LOCKING_PERIOD_SELF_VOTES,
	LOCKING_PERIOD_VOTES,
	MODULE_NAME_DPOS,
	PUNISHMENT_WINDOW_SELF_VOTES,
	PUNISHMENT_WINDOW_VOTES,
} from '../constants';
import { DelegateStore } from '../stores/delegate';
import { GenesisDataStore } from '../stores/genesis';
import { VoterStore } from '../stores/voter';
import { TokenMethod, TokenIDDPoS, UnlockCommandDependencies, UnlockingObject } from '../types';
import { isPunished, isCertificateGenerated } from '../utils';

export class UnlockCommand extends BaseCommand {
	private _tokenMethod!: TokenMethod;
	private _tokenIDDPoS!: TokenIDDPoS;
	private _roundLength!: number;

	public addDependencies(args: UnlockCommandDependencies) {
		this._tokenMethod = args.tokenMethod;
	}

	public init(args: { tokenIDDPoS: TokenIDDPoS; roundLength: number }) {
		this._tokenIDDPoS = args.tokenIDDPoS;
		this._roundLength = args.roundLength;
	}

	// TODO: Check verification logic
	// eslint-disable-next-line @typescript-eslint/require-await
	public async verify(context: CommandVerifyContext): Promise<VerificationResult> {
		const { transaction } = context;

		if (transaction.params.length !== 0) {
			return {
				status: VerifyStatus.FAIL,
				error: new Error('Unlock transaction params must be empty.'),
			};
		}

		return {
			status: VerifyStatus.OK,
		};
	}

	public async execute(context: CommandExecuteContext): Promise<void> {
		const {
			transaction: { senderAddress },
			getMethodContext,
			maxHeightCertified,
			header: { height },
		} = context;
		const delegateSubstore = this.stores.get(DelegateStore);
		const voterSubstore = this.stores.get(VoterStore);
		const voterData = await voterSubstore.get(context, senderAddress);
		// const ineligibleUnlocks = [];
		const genesisDataStore = this.stores.get(GenesisDataStore);
		const genesisData = await genesisDataStore.get(context, EMPTY_KEY);
		const { height: genesisHeight } = genesisData;

		for (const unlockObject of voterData.pendingUnlocks) {
			const { pomHeights } = await delegateSubstore.get(context, unlockObject.delegateAddress);

			if (
				this._isUnlockable(unlockObject, pomHeights, senderAddress, height) &&
				isCertificateGenerated({
					unlockObject,
					genesisHeight,
					maxHeightCertified,
					roundLength: this._roundLength,
				})
			) {
				// delete unlockObject from voterStore(senderAddress).pendingUnlocks
				await voterSubstore.del(context, senderAddress);

				await this._tokenMethod.unlock(
					getMethodContext(),
					senderAddress,
					MODULE_NAME_DPOS,
					this._tokenIDDPoS,
					unlockObject.amount,
				);
			}

			// if (
			// 	hasWaited(unlockObject, senderAddress, height) &&
			// 	!isPunished(unlockObject, pomHeights, senderAddress, height) &&
			// 	isCertificateGenerated({
			// 		unlockObject,
			// 		genesisHeight,
			// 		maxHeightCertified,
			// 		roundLength: this._roundLength,
			// 	})
			// ) {
			// 	await this._tokenMethod.unlock(
			// 		getMethodContext(),
			// 		senderAddress,
			// 		MODULE_NAME_DPOS,
			// 		this._tokenIDDPoS,
			// 		unlockObject.amount,
			// 	);
			// 	continue;
			// }
			// ineligibleUnlocks.push(unlockObject);
		}
		// if (voterData.pendingUnlocks.length === ineligibleUnlocks.length) {
		// 	throw new Error('No eligible voter data was found for unlocking');
		// }
		// voterData.pendingUnlocks = ineligibleUnlocks;
		// await voterSubstore.set(context, senderAddress, voterData);
	}

	public _isUnlockable(
		unlockObject: UnlockingObject,
		pomHeights: ReadonlyArray<number>,
		senderAddress: Buffer,
		height: number,
	): boolean {
		const { delegateAddress } = unlockObject;
		const lastPomHeight = pomHeights[pomHeights.length - 1];
		const lockingPeriod = delegateAddress.equals(senderAddress)
			? LOCKING_PERIOD_SELF_VOTES
			: LOCKING_PERIOD_VOTES;
		const punishmentWindow = delegateAddress.equals(senderAddress)
			? PUNISHMENT_WINDOW_SELF_VOTES
			: PUNISHMENT_WINDOW_VOTES;

		if (!isPunished(unlockObject, pomHeights, delegateAddress, height)) {
			if (height - unlockObject.unvoteHeight < lockingPeriod) {
				return false;
			}
		}

		return !(
			height - lastPomHeight < punishmentWindow &&
			lastPomHeight < unlockObject.unvoteHeight + lockingPeriod
		);
	}
}
