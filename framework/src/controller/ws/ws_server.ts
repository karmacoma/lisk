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
import * as WebSocket from 'ws';
import { Logger } from '../../logger';

interface WebSocketWithTracking extends WebSocket {
	isAlive?: boolean;
}

export class WSServer {
	public server!: WebSocket.Server;
	private pingTimer!: NodeJS.Timeout;
	private readonly port: number;
	private readonly path: string;
	private readonly logger: Logger;

	public constructor(options: { port: number; path: string; logger: Logger }) {
		this.port = options.port;
		this.path = options.path;
		this.logger = options.logger;
	}

	public start(): WebSocket.Server {
		this.server = new WebSocket.Server({ path: this.path, port: this.port, clientTracking: true });
		this.server.on('connection', socket => this._handleConnection(socket));
		this.server.on('error', error => {
			this.logger.error(error);
		});
		this.server.on('listening', () => {
			this.logger.info('Websocket Server Ready');
		});

		this.server.on('close', () => {
			clearInterval(this.pingTimer);
		});

		this.pingTimer = this._setUpPing();

		return this.server;
	}

	private _handleConnection(socket: WebSocketWithTracking) {
		// eslint-disable-next-line no-param-reassign
		socket.isAlive = true;
		socket.on('message', (message: Record<string, unknown>) =>
			this._handleMessage(socket, message),
		);
		socket.on('pong', () => this._handleHeartbeat(socket));
		this.logger.info('New web socket client connected');
	}

	// eslint-disable-next-line class-methods-use-this
	private _handleHeartbeat(socket: WebSocketWithTracking) {
		// eslint-disable-next-line no-param-reassign
		socket.isAlive = true;
	}

	// eslint-disable-next-line class-methods-use-this
	private _handleMessage(socket: WebSocketWithTracking, message: Record<string, unknown>) {
		socket.send(JSON.stringify({ data: message }));
	}

	private _setUpPing() {
		return setInterval(() => {
			for (const socket of this.server.clients) {
				const aClient = socket as WebSocketWithTracking;
				if (aClient.isAlive === false) {
					return socket.terminate();
				}

				aClient.isAlive = false;
				// eslint-disable-next-line @typescript-eslint/no-empty-function
				aClient.ping(() => {});
			}
			return null;
		}, 3000);
	}
}
