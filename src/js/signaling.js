/**
 * Copyright 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at
 *
 *   http://aws.amazon.com/asl/
 *
 * or in the "LICENSE" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import { hitch, wrapLogger } from './utils';
import { MAX_INVITE_DELAY_MS, MAX_ACCEPT_BYE_DELAY_MS, DEFAULT_CONNECT_TIMEOUT_MS } from './rtc_const';
import { UnsupportedOperation, Timeout, BusyException, CallNotFoundException, UnknownSignalingError } from './exceptions';

var reqIdSeq = 1;

/**
 * Abstract signaling state class.
 */
export class SignalingState {
    /**
     * @param {AmznRtcSignaling} signaling Signaling object.
     */
    constructor(signaling) {
        this._signaling = signaling;
    }
    setStateTimeout(timeoutMs) {
        setTimeout(hitch(this, this._onTimeoutChecked), timeoutMs);
    }
    get isCurrentState() {
        return this === this._signaling.state;
    }
    onEnter() {
    }
    _onTimeoutChecked() {
        if (this.isCurrentState) {
            this.onTimeout();
        }
    }
    onTimeout() {
        throw new UnsupportedOperation();
    }
    transit(newState) {
        this._signaling.transit(newState);
    }
    onExit() {
    }
    onOpen() {
        throw new UnsupportedOperation('onOpen not supported by ' + this.name);
    }
    onError() {
        this.channelDown();
    }
    onClose() {
        this.channelDown();
    }
    channelDown() {
        throw new UnsupportedOperation('channelDown not supported by ' + this.name);
    }
    onRpcMsg(rpcMsg) {// eslint-disable-line no-unused-vars
        throw new UnsupportedOperation('onRpcMsg not supported by ' + this.name);
    }
    invite(sdp, iceCandidates) {// eslint-disable-line no-unused-vars
        throw new UnsupportedOperation('invite not supported by ' + this.name);
    }
    accept() {
        throw new UnsupportedOperation('accept not supported by ' + this.name);
    }
    hangup() {
        throw new UnsupportedOperation('hangup not supported by ' + this.name);
    }
    get name() {
        return "SignalingState";
    }
    get logger() {
        return this._signaling._logger;
    }
}
export class FailOnTimeoutState extends SignalingState {
    constructor(signaling, timeoutMs) {
        super(signaling);
        this._stateTimeoutMs = timeoutMs;
    }
    onEnter() {
        this.setStateTimeout(this._stateTimeoutMs);
    }
    onTimeout() {
        this.transit(new FailedState(this._signaling, new Timeout()));
    }
    get name() {
        return "FailOnTimeoutState";
    }
}
export class PendingConnectState extends FailOnTimeoutState {
    constructor(signaling, timeoutMs) {
        super(signaling, timeoutMs);
    }
    onOpen() {
        this.transit(new PendingInviteState(this._signaling));
    }
    channelDown() {
        this.transit(new FailedState(this._signaling, new Error('channelDown')));
    }
    get name() {
        return "PendingConnectState";
    }
}
export class PendingInviteState extends SignalingState {
    onEnter() {
        var self = this;
        new Promise(function notifyConnected(resolve) {
            self._signaling._connectedHandler();
            resolve();
        });
    }
    invite(sdp, iceCandidates) {
        var self = this;
        var inviteId = reqIdSeq++;

        var inviteParams = {
            sdp: sdp,
            candidates: iceCandidates
        };
        self.logger.log('Sending SDP', sdp);
        self._signaling._wss.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'invite',
            params: inviteParams,
            id: inviteId
        }));
        self.transit(new PendingAnswerState(self._signaling, inviteId));
    }
    channelDown() {
        this.transit(new FailedState(this._signaling));
    }
    get name() {
        return "PendingInviteState";
    }
}
export class PendingAnswerState extends FailOnTimeoutState {
    constructor(signaling, inviteId) {
        super(signaling, MAX_INVITE_DELAY_MS);
        this._inviteId = inviteId;
    }
    onRpcMsg(msg) {
        var self = this;
        if (msg.id === this._inviteId) {
            if (msg.error || !msg.result) {
                this.transit(new FailedState(this._signaling, self.translateInviteError(msg)));
            } else {
                new Promise(function notifyAnswered(resolve) {
                    self.logger.log('Received SDP', msg.result.sdp);
                    self._signaling._answeredHandler(msg.result.sdp, msg.result.candidates);
                    resolve();
                });
                this.transit(new PendingAcceptState(this._signaling, this._signaling._autoAnswer));
            }
        }
    }
    translateInviteError(msg) {
        if (msg.error && msg.error.code == 486) {
            return new BusyException(msg.error.message);
        } else if (msg.error && msg.error.code == 404) {
            return new CallNotFoundException(msg.error.message);
        } else {
            return new UnknownSignalingError();
        }
    }

    get name() {
        return "PendingAnswerState";
    }
}
export class PendingAcceptState extends SignalingState {
    constructor(signaling, autoAnswer) {
        super(signaling);
        this._autoAnswer = autoAnswer;
    }
    onEnter() {
        if (this._autoAnswer) {
            this.accept();
        }
    }
    accept() {
        var acceptId = reqIdSeq++;
        this._signaling._wss.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'accept',
            params: {},
            id: acceptId
        }));
        this.transit(new PendingAcceptAckState(this._signaling, acceptId));
    }
    channelDown() {
        this.transit(new FailedState(this._signaling));
    }
    get name() {
        return "PendingAcceptState";
    }
}
export class PendingAcceptAckState extends FailOnTimeoutState {
    constructor(signaling, acceptId) {
        super(signaling, MAX_ACCEPT_BYE_DELAY_MS);
        this._acceptId = acceptId;
    }
    onRpcMsg(msg) {
        if (msg.id === this._acceptId) {
            if (msg.error) {
                this.transit(new FailedState(this._signaling));
            } else {
                this._signaling._clientToken = msg.result.clientToken;
                this.transit(new TalkingState(this._signaling));
            }
        }
    }
    get name() {
        return "PendingAcceptAckState";
    }
}
export class TalkingState extends SignalingState {
    onEnter() {
        var self = this;
        new Promise(function notifyHandshaked(resolve) {
            self._signaling._handshakedHandler();
            resolve();
        });
    }
    hangup() {
        var byeId = reqIdSeq++;
        this._signaling._wss.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'bye',
            params: {},
            id: byeId
        }));
        this.transit(new PendingRemoteHangupState(this._signaling, byeId));
    }
    onRpcMsg(msg) {
        if (msg.method === 'bye') {
            this.transit(new PendingLocalHangupState(this._signaling, msg.id));
        } else if (msg.method === 'renewClientToken') {
            this._signaling._clientToken = msg.params.clientToken;
        }
    }
    channelDown() {
        this._signaling._reconnect();
        this._signaling.transit(new PendingReconnectState(this._signaling));
    }
    get name() {
        return "TalkingState";
    }
}
export class PendingReconnectState extends FailOnTimeoutState {
    constructor(signaling) {
        super(signaling, DEFAULT_CONNECT_TIMEOUT_MS);
    }
    onOpen() {
        this.transit(new TalkingState(this._signaling));
    }
    channelDown() {
        this.transit(new FailedState(this._signaling));
    }
    get name() {
        return "PendingReconnectState";
    }
}
export class PendingRemoteHangupState extends FailOnTimeoutState {
    constructor(signaling, byeId) {
        super(signaling, MAX_ACCEPT_BYE_DELAY_MS);
        this._byeId = byeId;
    }
    onRpcMsg(msg) {
        if (msg.id === this._byeId) {
            this.transit(new DisconnectedState(this._signaling));
        }
    }
    get name() {
        return "PendingRemoteHangupState";
    }
}
export class PendingLocalHangupState extends SignalingState {
    constructor(signaling, byeId) {
        super(signaling);
        this._byeId = byeId;
    }
    onEnter() {
        var self = this;
        new Promise(function notifyRemoteHungup(resolve) {
            self._signaling._remoteHungupHandler();
            resolve();
        });
    }
    hangup() {
        var self = this;
        self._signaling._wss.send(JSON.stringify({
            jsonrpc: '2.0',
            result: {},
            id: self._byeId
        }));
        self.transit(new DisconnectedState(self._signaling));
    }
    channelDown() {
        this.transit(new DisconnectedState(this._signaling));
    }
    get name() {
        return "PendingLocalHangupState";
    }
}
export class DisconnectedState extends SignalingState {
    onEnter() {
        var self = this;
        new Promise(function notifyDisconnected(resolve) {
            self._signaling._disconnectedHandler();
            resolve();
        });
        this._signaling._wss.close();
    }
    channelDown() {
        //Do nothing
    }
    get name() {
        return "DisconnectedState";
    }
}
export class FailedState extends SignalingState {
    constructor(signaling, exception) {
        super(signaling);
        this._exception = exception;
    }
    onEnter() {
        var self = this;
        new Promise(function notifyFailed(resolve) {
            self._signaling._failedHandler(self._exception);
            resolve();
        });
        this._signaling._wss.close();
    }
    channelDown() {
        //Do nothing
    }
    get name() {
        return "FailedState";
    }
    get exception() {
        return this._exception;
    }
}

export default class AmznRtcSignaling {
    constructor(callId, signalingUri, contactToken, logger, connectTimeoutMs) {
        this._callId = callId;
        this._connectTimeoutMs = connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
        this._autoAnswer = true;
        this._signalingUri = signalingUri;
        this._contactToken = contactToken;
        this._logger = wrapLogger(logger, callId, 'SIGNALING');

        //empty event handlers
        this._connectedHandler =
            this._answeredHandler =
            this._handshakedHandler =
            this._reconnectedHandler =
            this._remoteHungupHandler =
            this._disconnectedHandler =
            this._failedHandler = function noOp() {
            };
    }
    get callId() {
        return this._callId;
    }
    set onConnected(connectedHandler) {
        this._connectedHandler = connectedHandler;
    }
    set onAnswered(answeredHandler) {
        this._answeredHandler = answeredHandler;
    }
    set onHandshaked(handshakedHandler) {
        this._handshakedHandler = handshakedHandler;
    }
    set onReconnected(reconnectedHandler) {
        this._reconnectedHandler = reconnectedHandler;
    }
    set onRemoteHungup(remoteHungupHandler) {
        this._remoteHungupHandler = remoteHungupHandler;
    }
    set onDisconnected(disconnectedHandler) {
        this._disconnectedHandler = disconnectedHandler;
    }
    set onFailed(failedHandler) {
        this._failedHandler = failedHandler;
    }
    get state() {
        return this._state;
    }
    connect() {
        this._wss = this._connectWebSocket(this._buildInviteUri());
        this.transit(new PendingConnectState(this, this._connectTimeoutMs));
    }
    transit(nextState) {
        try {
            this._logger.info((this._state ? this._state.name : 'null') + ' => ' + nextState.name);
            if (this.state && this.state.onExit) {
                this.state.onExit();
            }
        } finally {
            this._state = nextState;
            if (this._state.onEnter) {
                this._state.onEnter();
            }
        }
    }
    _connectWebSocket(uri) {
        var wsConnection = new WebSocket(uri);
        wsConnection.onopen = hitch(this, this._onOpen);
        wsConnection.onmessage = hitch(this, this._onMessage);
        wsConnection.onerror = hitch(this, this._onError);
        wsConnection.onclose = hitch(this, this._onClose);
        return wsConnection;
    }
    _buildInviteUri() {
        return this._buildUriBase() + '&contactCtx=' + encodeURIComponent(this._contactToken);
    }
    _buildReconnectUri() {
        return this._buildUriBase() + '&clientToken=' + encodeURIComponent(this._clientToken);
    }
    _buildUriBase() {
        return this._signalingUri + '?callId=' + encodeURIComponent(this._callId);
    }
    _onMessage(evt) {
        this.state.onRpcMsg(JSON.parse(evt.data));
    }
    _onOpen(evt) {
        this.state.onOpen(evt);
    }
    _onError(evt) {
        this.state.onError(evt);
    }
    _onClose(evt) {
        this._logger.log('WebSocket onclose code=' + evt.code + ', reason=' + evt.reason);
        this.state.onClose(evt);
    }
    _reconnect() {
        this._wss = this._connectWebSocket(this._buildReconnectUri());
    }
    invite(sdp, iceCandidates) {
        this.state.invite(sdp, iceCandidates);
    }
    accept() {
        this.state.accept();
    }
    hangup() {
        this.state.hangup();
    }
}