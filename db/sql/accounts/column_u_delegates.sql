/*
 * Copyright © 2018 Lisk Foundation
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


/*
  DESCRIPTION: Dynamic-field query for column "u_delegates"

  PARAMETERS: None
*/

(
	SELECT array_agg("dependentId")
	FROM (
		SELECT ENCODE("dependentId", 'hex') AS "dependentId"
		FROM mem_accounts2u_delegates
		WHERE "accountId" = mem_accounts.address
	) AS u_delegates_public_keys_for_account
)
