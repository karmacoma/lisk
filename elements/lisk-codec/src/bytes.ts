/*
 * Copyright © 2020 Lisk Foundation
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
import { writeVarInt } from './varint';

interface SchemaProperty {
	readonly dataType: string;
}

export const writeBytes = (bytes: Buffer, _schema: SchemaProperty): Buffer =>
	Buffer.concat([writeVarInt(bytes.length, { dataType: 'uint32' }), bytes]);

export const readBytes = (buffer: Buffer, _schema: SchemaProperty): Buffer =>
	buffer.slice(1, buffer.length);
