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
import { address as cryptoAddress } from '@liskhq/lisk-cryptography';
import { NotFoundError } from '@liskhq/lisk-chain';
import { MAX_UINT64 } from '@liskhq/lisk-validator';
import { codec } from '@liskhq/lisk-codec';
import { ImmutableAPIContext, APIContext } from '../../state_machine';
import { BaseAPI } from '../base_api';
import {
	ADDRESS_LENGTH,
	CCM_STATUS_OK,
	CHAIN_ID_ALIAS_NATIVE,
	EMPTY_BYTES,
	LOCAL_ID_LENGTH,
	TOKEN_ID_LSK,
	CROSS_CHAIN_COMMAND_NAME_FORWARD,
	CROSS_CHAIN_COMMAND_NAME_TRANSFER,
} from './constants';
import {
	crossChainForwardMessageParams,
	crossChainTransferMessageParams,
	UserStoreData,
} from './schemas';
import { MinBalance, TokenID } from './types';
import { getNativeTokenID, splitTokenID } from './utils';
import { MainchainInteroperabilityAPI, SidechainInteroperabilityAPI } from '../interoperability';
import { UserStore } from './stores/user';
import { EscrowStore } from './stores/escrow';
import { AvailableLocalIDStore } from './stores/available_local_id';
import { SupplyStore } from './stores/supply';
import { NamedRegistry } from '../named_registry';
import { TransferEvent, TransferEventResult } from './events/transfer';

export class TokenAPI extends BaseAPI {
	private readonly _moduleName: string;
	private _minBalances!: MinBalance[];
	private _interoperabilityAPI!: MainchainInteroperabilityAPI | SidechainInteroperabilityAPI;

	public constructor(stores: NamedRegistry, events: NamedRegistry, moduleName: string) {
		super(stores, events);
		this._moduleName = moduleName;
	}

	public init(args: { minBalances: MinBalance[] }): void {
		this._minBalances = args.minBalances;
	}

	public addDependencies(
		interoperabilityAPI: MainchainInteroperabilityAPI | SidechainInteroperabilityAPI,
	) {
		this._interoperabilityAPI = interoperabilityAPI;
	}

	public async getAvailableBalance(
		apiContext: ImmutableAPIContext,
		address: Buffer,
		tokenID: TokenID,
	): Promise<bigint> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const userStore = this.stores.get(UserStore);
		try {
			const user = await userStore.get(apiContext, userStore.getKey(address, canonicalTokenID));
			return user.availableBalance;
		} catch (error) {
			if (!(error instanceof NotFoundError)) {
				throw error;
			}
			return BigInt(0);
		}
	}

	public async getLockedAmount(
		apiContext: ImmutableAPIContext,
		address: Buffer,
		tokenID: TokenID,
		module: string,
	): Promise<bigint> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const userStore = this.stores.get(UserStore);
		try {
			const user = await userStore.get(apiContext, userStore.getKey(address, canonicalTokenID));
			return user.lockedBalances.find(lb => lb.module === module)?.amount ?? BigInt(0);
		} catch (error) {
			if (!(error instanceof NotFoundError)) {
				throw error;
			}
			return BigInt(0);
		}
	}

	public async getEscrowedAmount(
		apiContext: ImmutableAPIContext,
		escrowChainID: Buffer,
		tokenID: TokenID,
	): Promise<bigint> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const isNative = await this.isNative(apiContext, canonicalTokenID);
		if (!isNative) {
			throw new Error('Only native token can have escrow amount.');
		}
		const [, localID] = splitTokenID(tokenID);
		const escrowStore = this.stores.get(EscrowStore);
		try {
			const { amount } = await escrowStore.get(apiContext, Buffer.concat([escrowChainID, localID]));
			return amount;
		} catch (error) {
			if (!(error instanceof NotFoundError)) {
				throw error;
			}
			return BigInt(0);
		}
	}

	public async accountExists(apiContext: ImmutableAPIContext, address: Buffer): Promise<boolean> {
		const userStore = this.stores.get(UserStore);
		return userStore.accountExist(apiContext, address);
	}

	public async getNextAvailableLocalID(apiContext: ImmutableAPIContext): Promise<Buffer> {
		const nextAvailableLocalIDStore = this.stores.get(AvailableLocalIDStore);
		const { nextAvailableLocalID } = await nextAvailableLocalIDStore.get(apiContext, EMPTY_BYTES);

		return nextAvailableLocalID;
	}

	public async initializeToken(apiContext: APIContext, localID: Buffer): Promise<void> {
		const supplyStore = this.stores.get(SupplyStore);
		const supplyExist = await supplyStore.has(apiContext, localID);
		if (supplyExist) {
			throw new Error('Token is already initialized.');
		}
		await supplyStore.set(apiContext, localID, { totalSupply: BigInt(0) });

		const nextAvailableLocalIDStore = this.stores.get(AvailableLocalIDStore);
		const { nextAvailableLocalID } = await nextAvailableLocalIDStore.get(apiContext, EMPTY_BYTES);
		if (localID.compare(nextAvailableLocalID) >= 0) {
			const newAvailableLocalID = Buffer.alloc(LOCAL_ID_LENGTH);
			newAvailableLocalID.writeUInt32BE(localID.readUInt32BE(0) + 1, 0);
			await nextAvailableLocalIDStore.set(apiContext, EMPTY_BYTES, {
				nextAvailableLocalID: newAvailableLocalID,
			});
		}
	}

	public async mint(
		apiContext: APIContext,
		address: Buffer,
		tokenID: TokenID,
		amount: bigint,
	): Promise<void> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const isNative = await this.isNative(apiContext, canonicalTokenID);
		if (!isNative) {
			throw new Error('Only native token can be minted.');
		}
		if (amount < BigInt(0)) {
			throw new Error('Amount must be a positive integer to mint.');
		}
		const [, localID] = splitTokenID(canonicalTokenID);
		const supplyStore = this.stores.get(SupplyStore);
		const supplyExist = await supplyStore.has(apiContext, localID);
		if (!supplyExist) {
			throw new Error(`LocalID ${localID.toString('hex')} is not initialized to mint.`);
		}
		const supply = await supplyStore.get(apiContext, localID);
		if (supply.totalSupply > MAX_UINT64 - amount) {
			throw new Error(`Supply cannot exceed MAX_UINT64 ${MAX_UINT64.toString()}.`);
		}

		const userStore = this.stores.get(UserStore);
		const recipientExist = await userStore.accountExist(apiContext, address);

		const minBalance = this._getMinBalance(canonicalTokenID);
		let receivedAmount = amount;
		if (!recipientExist) {
			if (!minBalance) {
				throw new Error(
					`Address cannot be initialized because min balance is not set for TokenID ${canonicalTokenID.toString(
						'hex',
					)}.`,
				);
			}
			if (minBalance > receivedAmount) {
				throw new Error(
					`Amount ${receivedAmount.toString()} does not satisfy min balance requirement.`,
				);
			}
			receivedAmount -= minBalance;
		}

		let recipient: UserStoreData;
		try {
			recipient = await userStore.get(apiContext, userStore.getKey(address, canonicalTokenID));
		} catch (error) {
			if (!(error instanceof NotFoundError)) {
				throw error;
			}
			recipient = {
				availableBalance: BigInt(0),
				lockedBalances: [],
			};
		}
		recipient.availableBalance += receivedAmount;
		await userStore.set(apiContext, userStore.getKey(address, canonicalTokenID), recipient);
		supply.totalSupply += receivedAmount;
		await supplyStore.set(apiContext, localID, supply);
	}

	public async burn(
		apiContext: APIContext,
		address: Buffer,
		tokenID: TokenID,
		amount: bigint,
	): Promise<void> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const isNative = await this.isNative(apiContext, canonicalTokenID);
		if (!isNative) {
			throw new Error('Only native token can be burnt.');
		}
		if (amount < BigInt(0)) {
			throw new Error('Amount must be a positive integer to burn.');
		}
		const userStore = this.stores.get(UserStore);
		const sender = await userStore.get(apiContext, userStore.getKey(address, canonicalTokenID));
		if (sender.availableBalance < amount) {
			throw new Error(
				`Sender ${address.toString(
					'hex',
				)} balance ${sender.availableBalance.toString()} is not sufficient for ${amount.toString()}`,
			);
		}
		sender.availableBalance -= amount;
		await userStore.set(apiContext, userStore.getKey(address, canonicalTokenID), sender);

		const supplyStore = this.stores.get(SupplyStore);
		const [, localID] = splitTokenID(canonicalTokenID);
		const supply = await supplyStore.get(apiContext, localID);
		supply.totalSupply -= amount;
		await supplyStore.set(apiContext, localID, supply);
	}

	public async transfer(
		apiContext: APIContext,
		senderAddress: Buffer,
		recipientAddress: Buffer,
		tokenID: TokenID,
		amount: bigint,
	): Promise<void> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const userStore = this.stores.get(UserStore);
		const sender = await userStore.get(
			apiContext,
			userStore.getKey(senderAddress, canonicalTokenID),
		);
		if (sender.availableBalance < amount) {
			throw new Error(
				`Sender ${senderAddress.toString(
					'hex',
				)} balance ${sender.availableBalance.toString()} is not sufficient for ${amount.toString()}`,
			);
		}
		sender.availableBalance -= amount;
		await userStore.set(apiContext, userStore.getKey(senderAddress, canonicalTokenID), sender);

		const recipientExist = await userStore.accountExist(apiContext, recipientAddress);

		const minBalance = this._getMinBalance(canonicalTokenID);
		let receivedAmount = amount;
		if (!recipientExist) {
			if (!minBalance) {
				throw new Error(
					`Address cannot be initialized because min balance is not set for TokenID ${canonicalTokenID.toString(
						'hex',
					)}.`,
				);
			}
			if (minBalance > receivedAmount) {
				throw new Error(
					`Amount ${receivedAmount.toString()} does not satisfy min balance requirement.`,
				);
			}
			receivedAmount -= minBalance;
			const [chainID] = splitTokenID(canonicalTokenID);
			if (chainID.equals(CHAIN_ID_ALIAS_NATIVE)) {
				const supplyStore = this.stores.get(SupplyStore);
				const [, localID] = splitTokenID(canonicalTokenID);
				const supply = await supplyStore.get(apiContext, localID);
				supply.totalSupply -= minBalance;
				await supplyStore.set(apiContext, localID, supply);
			}
		}

		let recipient: UserStoreData;
		try {
			recipient = await userStore.get(
				apiContext,
				userStore.getKey(recipientAddress, canonicalTokenID),
			);
		} catch (error) {
			if (!(error instanceof NotFoundError)) {
				throw error;
			}
			recipient = {
				availableBalance: BigInt(0),
				lockedBalances: [],
			};
		}
		recipient.availableBalance += receivedAmount;
		await userStore.set(
			apiContext,
			userStore.getKey(recipientAddress, canonicalTokenID),
			recipient,
		);
		const transferEvent = this.events.get(TransferEvent);
		transferEvent.log(apiContext, {
			amount,
			recipientAddress,
			result: TransferEventResult.SUCCESSFUL,
			senderAddress,
			tokenID,
		});
	}

	public async lock(
		apiContext: APIContext,
		address: Buffer,
		module: string,
		tokenID: TokenID,
		amount: bigint,
	): Promise<void> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		if (amount < BigInt(0)) {
			throw new Error('Amount must be a positive integer to lock.');
		}
		const userStore = this.stores.get(UserStore);
		const user = await userStore.get(apiContext, userStore.getKey(address, canonicalTokenID));
		if (user.availableBalance < amount) {
			throw new Error(
				`User ${address.toString(
					'hex',
				)} balance ${user.availableBalance.toString()} is not sufficient for ${amount.toString()}`,
			);
		}
		user.availableBalance -= amount;
		const existingIndex = user.lockedBalances.findIndex(b => b.module === module);
		if (existingIndex > -1) {
			const locked = user.lockedBalances[existingIndex].amount + amount;
			user.lockedBalances[existingIndex] = {
				module,
				amount: locked,
			};
		} else {
			user.lockedBalances.push({
				module,
				amount,
			});
		}
		user.lockedBalances.sort((a, b) => a.module.localeCompare(b.module, 'en'));
		await userStore.set(apiContext, userStore.getKey(address, canonicalTokenID), user);
	}

	public async unlock(
		apiContext: APIContext,
		address: Buffer,
		module: string,
		tokenID: TokenID,
		amount: bigint,
	): Promise<void> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		if (amount < BigInt(0)) {
			throw new Error('Amount must be a positive integer to unlock.');
		}

		const userStore = this.stores.get(UserStore);
		const user = await userStore.get(apiContext, userStore.getKey(address, canonicalTokenID));
		const lockedIndex = user.lockedBalances.findIndex(b => b.module === module);
		if (lockedIndex < 0) {
			throw new Error(`No balance is locked for module ${module}`);
		}
		const lockedObj = user.lockedBalances[lockedIndex];
		if (lockedObj.amount < amount) {
			throw new Error(
				`Not enough amount is locked for module ${module} to unlock ${amount.toString()}`,
			);
		}
		lockedObj.amount -= amount;
		user.availableBalance += amount;
		if (lockedObj.amount !== BigInt(0)) {
			user.lockedBalances[lockedIndex] = lockedObj;
		} else {
			user.lockedBalances.splice(lockedIndex, 1);
		}
		await userStore.set(apiContext, userStore.getKey(address, canonicalTokenID), user);
	}

	public async isNative(apiContext: ImmutableAPIContext, tokenID: TokenID): Promise<boolean> {
		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const [chainID] = splitTokenID(canonicalTokenID);
		return chainID.equals(CHAIN_ID_ALIAS_NATIVE);
	}

	public async transferCrossChain(
		apiContext: APIContext,
		senderAddress: Buffer,
		receivingChainID: Buffer,
		recipientAddress: Buffer,
		tokenID: Buffer,
		amount: bigint,
		messageFee: bigint,
		data: string,
	): Promise<void> {
		if (amount < BigInt(0)) {
			throw new Error('Amount must be greater or equal to zero.');
		}
		if (senderAddress.length !== ADDRESS_LENGTH) {
			throw new Error(
				`Invalid sender address ${cryptoAddress.getLisk32AddressFromAddress(senderAddress)}.`,
			);
		}
		if (recipientAddress.length !== ADDRESS_LENGTH) {
			throw new Error(
				`Invalid recipient address ${cryptoAddress.getLisk32AddressFromAddress(recipientAddress)}.`,
			);
		}

		const canonicalTokenID = await this.getCanonicalTokenID(apiContext, tokenID);
		const userStore = this.stores.get(UserStore);
		const sender = await userStore.get(
			apiContext,
			userStore.getKey(senderAddress, canonicalTokenID),
		);

		if (sender.availableBalance < amount) {
			throw new Error(
				`Sender ${senderAddress.toString(
					'hex',
				)} balance ${sender.availableBalance.toString()} is not sufficient for ${amount.toString()}`,
			);
		}
		const [chainID, localID] = splitTokenID(canonicalTokenID);

		const [LSK_CHAIN_ID] = splitTokenID(TOKEN_ID_LSK);
		const possibleChainIDs = [CHAIN_ID_ALIAS_NATIVE, receivingChainID, LSK_CHAIN_ID];
		const isAllowed = possibleChainIDs.some(id => id.equals(chainID));
		if (!isAllowed) {
			throw new Error(`Invalid chain id ${chainID.toString('hex')} for transfer cross chain.`);
		}
		let newTokenID: Buffer;
		if (CHAIN_ID_ALIAS_NATIVE.equals(chainID)) {
			const { id: ownChainID } = await this._interoperabilityAPI.getOwnChainAccount(apiContext);
			newTokenID = Buffer.concat([ownChainID, localID]);
		} else {
			newTokenID = tokenID;
		}

		if ([CHAIN_ID_ALIAS_NATIVE, receivingChainID].some(id => id.equals(chainID))) {
			const message = codec.encode(crossChainTransferMessageParams, {
				tokenID: newTokenID,
				amount,
				senderAddress,
				recipientAddress,
				data,
			});
			const sendResult = await this._interoperabilityAPI.send(
				apiContext,
				senderAddress,
				this._moduleName,
				CROSS_CHAIN_COMMAND_NAME_TRANSFER,
				receivingChainID,
				messageFee,
				CCM_STATUS_OK,
				message,
			);
			if (!sendResult) {
				return;
			}
			sender.availableBalance -= amount;
			await userStore.set(apiContext, userStore.getKey(senderAddress, canonicalTokenID), sender);
			if (chainID.equals(CHAIN_ID_ALIAS_NATIVE)) {
				const escrowStore = this.stores.get(EscrowStore);
				await escrowStore.addAmount(apiContext, receivingChainID, localID, amount);
			}
			return;
		}
		if (sender.availableBalance < amount + messageFee) {
			throw new Error(
				`Sender ${senderAddress.toString(
					'hex',
				)} balance ${sender.availableBalance.toString()} is not sufficient for ${(
					amount + messageFee
				).toString()}`,
			);
		}
		const message = codec.encode(crossChainForwardMessageParams, {
			tokenID,
			amount,
			senderAddress,
			forwardToChainID: receivingChainID,
			recipientAddress,
			data,
			forwardedMessageFee: messageFee,
		});
		const sendResult = await this._interoperabilityAPI.send(
			apiContext,
			senderAddress,
			this._moduleName,
			CROSS_CHAIN_COMMAND_NAME_FORWARD,
			chainID,
			BigInt(0),
			CCM_STATUS_OK,
			message,
		);
		if (!sendResult) {
			return;
		}
		sender.availableBalance -= amount + messageFee;
		await userStore.set(apiContext, userStore.getKey(senderAddress, canonicalTokenID), sender);
	}

	public async getCanonicalTokenID(
		apiContext: ImmutableAPIContext,
		tokenID: TokenID,
	): Promise<TokenID> {
		const [chainID] = splitTokenID(tokenID);
		// tokenID is already canonical
		if (chainID.equals(CHAIN_ID_ALIAS_NATIVE)) {
			return tokenID;
		}
		const { id } = await this._interoperabilityAPI.getOwnChainAccount(apiContext);
		if (chainID.equals(id)) {
			return getNativeTokenID(tokenID);
		}
		return tokenID;
	}

	private _getMinBalance(tokenID: TokenID): bigint | undefined {
		const minBalance = this._minBalances.find(mb => mb.tokenID.equals(tokenID));
		return minBalance?.amount;
	}
}
