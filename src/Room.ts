import winston from "winston";
import * as uuid from "uuid";

import {
    Color,
    DisconnectReason,
    GameDataMessageTag,
    GameOverReason,
    GameState,
    RpcMessageTag
} from "@skeldjs/constant";

import {
    BaseGameDataMessage,
    BaseRootMessage,
    ClientInfoMessage,
    CloseDoorsOfTypeMessage,
    CompleteTaskMessage,
    DataMessage,
    DespawnMessage,
    EndGameMessage,
    GameDataMessage,
    GameDataToMessage,
    GameOptions,
    HostGameMessage,
    JoinedGameMessage,
    JoinGameMessage,
    MessageDirection,
    MurderPlayerMessage,
    PacketDecoder,
    PlayAnimationMessage,
    ReadyMessage,
    ReliablePacket,
    RemoveGameMessage,
    RemovePlayerMessage,
    RepairSystemMessage,
    RpcMessage,
    SceneChangeMessage,
    SetColorMessage,
    SetNameMessage,
    SetTasksMessage,
    StartGameMessage,
    UnreliablePacket,
    WaitForHostMessage
} from "@skeldjs/protocol";

import { Code2Int, HazelWriter, Int2Code } from "@skeldjs/util";

import { Hostable, HostableEvents, PlayerData, RoomFixedUpdateEvent } from "@skeldjs/core";

import { Client } from "./Client";
import { WorkerNode } from "./WorkerNode";
import { Anticheat } from "./Anticheat";
import { fmtPlayer } from "./util/format-player";
import { fmtClient } from "./util/format-client";

export class Room extends Hostable {
    logger: winston.Logger;

    uuid: string;

    code: number;
    clients: Map<number, Client>;
    settings: GameOptions;
    state: GameState;
    
    waiting: Set<Client>;

    anticheat: Anticheat;

    constructor(private server: WorkerNode) {
        super({ doFixedUpdate: true });

        this.uuid = uuid.v4();

        this.code = 0;
        this.clients = new Map;
        this.settings = new GameOptions;
        this.state = GameState.NotStarted;
        
        this.waiting = new Set;

        this.anticheat = new Anticheat(this.server, this);
        
        this.logger = winston.createLogger({
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.colorize(),
                        winston.format.printf(info => {
                            return `[${this.name}] ${info.level}: ${info.message}`;
                        }),
                    ),
                }),
                new winston.transports.File({
                    filename: "logs/" + this.uuid + ".txt",
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.simple()
                    )
                })
            ]
        });

        this.on("player.setname", setname => {
            this.logger.info(
                "Player %s changed their name from %s to %s.",
                fmtPlayer(setname.player), setname.oldName, setname.newName
            );
        });
        
        this.on("player.setcolor", setcolor => {
            this.logger.info(
                "Player %s changed their color from %s to %s.",
                fmtPlayer(setcolor.player), Color[setcolor.oldColor], Color[setcolor.newColor]
            );
        });
    }

    get name() {
        return Int2Code(this.code);
    }

    get destroyed() {
        return this.state === GameState.Destroyed;
    }
    
    async emit<Event extends HostableEvents[keyof HostableEvents]>(event: Event): Promise<Event> {
        await this.server.emit(event);

        return super.emit(event);
    }
    
    async FixedUpdate() {
        const delta = Date.now() - (this as any).last_fixed_update;
        (this as any).last_fixed_update = Date.now();
        for (const [, component] of this.netobjects) {
            if (
                component
            ) {
                component.FixedUpdate(delta / 1000);
                if (component.dirtyBit) {
                    component.PreSerialize();
                    const writer = HazelWriter.alloc(0);
                    if (component.Serialize(writer, false)) {
                        this.stream.push(
                            new DataMessage(component.netid, writer.buffer)
                        );
                    }
                    component.dirtyBit = 0;
                }
            }
        }

        const ev = await this.emit(
            new RoomFixedUpdateEvent(
                this,
                this.stream
            )
        );

        if (this.stream.length) {
            const stream = this.stream;
            this.stream = [];

            if (!ev.canceled) await this.broadcast(stream);
        }
    }

    async destroy() {
        super.destroy();

        await this.broadcast([], true, null, [
            new RemoveGameMessage(DisconnectReason.Destroy)
        ]);

        this.state = GameState.Destroyed;
        this.server.rooms.delete(this.code);

        await this.server.redis.del("room." + this.name);

        this.logger.info("Room was destroyed.");
    }
/*
    hashGameDataMessage(message: BaseGameDataMessage) {
        let out = "";

        switch (message.tag) {
        case GameDataMessageTag.Data:
            const dataMessage = message as DataMessage;
            out += dataMessage.netid;
            out += dataMessage.data;
            break;
        case GameDataMessageTag.RPC:
            const rpcMessage = message as RpcMessage;
            out += rpcMessage.netid;
            out += rpcMessage.data.tag;
            switch (rpcMessage.data.tag) {
                case RpcMessageTag.PlayAnimation:
                    const rpcPlayAnimation = rpcMessage.data as PlayAnimationMessage;
                    out += rpcPlayAnimation.taskid;
                    break;
                case RpcMessageTag.CompleteTask:
                    const rpcCompleteTask = rpcMessage.data as CompleteTaskMessage;
                    out += rpcCompleteTask.taskidx;
                    break;
                case RpcMessageTag.MurderPlayer:
                    const rpcMurderPlayer = rpcMessage.data as MurderPlayerMessage;
                    out += rpcMurderPlayer.victimid;
                    break;
                case RpcMessageTag.SendChat:
                case RpcMessageTag.SendChatNote:
                case RpcMessageTag.CastVote:
                case RpcMessageTag.AddVote:
                    return "";
                case RpcMessageTag.CloseDoorsOfType:
                    const rpcCloseDoorsOfType = rpcMessage.data as CloseDoorsOfTypeMessage;
                    out += rpcCloseDoorsOfType.systemid;
                    break;
                case RpcMessageTag.RepairSystem:
                    const rpcRepairSystem = rpcMessage.data as RepairSystemMessage;
                    out += rpcRepairSystem.systemid;
                    break;
                case RpcMessageTag.SetTasks:
                    const rpcSetTasks = rpcMessage.data as SetTasksMessage;
                    out += rpcSetTasks.playerid;
                    break;
            }
            break;
        case GameDataMessageTag.Despawn:
            const despawnMessage = message as DespawnMessage;
            out += despawnMessage.netid;
            break;
        case GameDataMessageTag.SceneChange:
            const sceneChangeMessage = message as SceneChangeMessage;
            out += sceneChangeMessage.clientid;
            out += sceneChangeMessage.scene;
            break;
        case GameDataMessageTag.Ready:
            const readyMessage = message as ReadyMessage;
            out += readyMessage.clientid;
            break;
        case GameDataMessageTag.ClientInfo:
            const clientInfo = message as ClientInfoMessage;
            out += clientInfo.platform;
            break;
        default:
            return "";
        }

        return out;
    }

    compressGameData(messages: BaseGameDataMessage[]) {
        const unnecessaryMessages = new Set;
        const toSend = [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            const hash = this.hashGameDataMessage(message);
            
            if (!hash) {
                toSend.unshift(message);
                continue;
            }

            if (unnecessaryMessages.has(hash))
                continue;

            unnecessaryMessages.add(hash);
            toSend.unshift(message);
        }
        return toSend;
    }*/

    async broadcast(
        messages: BaseGameDataMessage[],
        reliable: boolean = true,
        recipient: PlayerData | null = null,
        payloads: BaseRootMessage[] = []
    ) {
        const compressedMessages = messages; // Currently not compressing messages until there is a faster way (if any)

        if (recipient) {
            const remote = this.clients.get(recipient.id);

            if (remote) {
                const children = [
                    ...(compressedMessages?.length ? [new GameDataToMessage(
                        this.code,
                        remote.clientid,
                        compressedMessages
                    )] : []),
                    ...payloads
                ]
                
                if (!children.length)
                    return;

                await remote.send(
                    reliable
                        ? new ReliablePacket(remote.getNextNonce(), children)
                        : new UnreliablePacket(children)
                );
            }
        } else {
            const children = [
                ...(compressedMessages?.length ? [new GameDataMessage(
                    this.code,
                    compressedMessages
                )] : []),
                ...payloads
            ];

            if (!children.length)
                return;

            await Promise.all(
                [...this.clients]
                    // .filter(([, client]) => !exclude.includes(client))
                    .map(([, client]) => {
                        return client.send(
                            reliable
                                ? new ReliablePacket(client.getNextNonce(), children)
                                : new UnreliablePacket(children)
                        )
                    })
            );
        }
    }

    async setCode(code: number|string): Promise<void> {
        if (typeof code === "string") {
            return this.setCode(Code2Int(code));
        }

        if (this.code) {
            this.logger.info(
                "Game code changed to [%s]",
                Int2Code(code) 
            );
        }

        super.setCode(code);

        await this.broadcast([], true, null, [
            new HostGameMessage(code)
        ]);
    }

    async updateHost(client: Client) {
        await this.broadcast([], true, null, [
            new JoinGameMessage(
                this.code,
                -1,
                client.clientid
            ),
            new RemovePlayerMessage(
                this.code,
                -1,
                DisconnectReason.None,
                client.clientid
            )
        ]);
    }

    async setHost(player: PlayerData) {
        const remote = this.clients.get(player.id);

        await super.setHost(player);

        if (remote && this.state === GameState.Ended && this.waiting.has(remote)) {
            await this.handleRemoteJoin(remote);
        }

        this.logger.info(
            "Host changed to %s",
            fmtPlayer(player)
        );
    }

    async handleRemoteLeave(client: Client, reason: DisconnectReason = DisconnectReason.None) {
        await super.handleLeave(client.clientid);

        this.clients.delete(client.clientid);

        if (this.clients.size === 0) {
            await this.destroy();
            return;
        }

        await this.setHost([...this.players.values()][0]);

        await this.broadcast([], true, null, [
            new RemovePlayerMessage(
                this.code,
                client.clientid,
                reason,
                this.hostid
            )
        ]);

        this.logger.info(
            "%s left or was removed.",
            fmtClient(client)
        );
    }

    async handleRemoteJoin(client: Client) {
        const player = await super.handleJoin(client.clientid);

        if (!player)
            return;

        if (!this.host)
            await this.setHost(player);

        client.room = this;

        if (this.state === GameState.Ended) {
            await this.broadcast([], true, null, [
                new JoinGameMessage(
                    this.code,
                    client.clientid,
                    this.host!.id
                )
            ]);

            if (client.clientid === this.hostid) {
                this.state = GameState.NotStarted;
                
                for (const [ , client ] of this.clients) {
                    if (!this.waiting.has(client)) {
                        this.clients.delete(client.clientid);
                    }
                }

                await Promise.all(
                    [...this.waiting].map(waiting => {
                        return waiting.send(
                            new JoinedGameMessage(
                                this.code,
                                client.clientid,
                                this.host!.id,
                                [...this.clients]
                                    .map(([, client]) => client.clientid)
                            )
                        );
                    })
                );
            } else {
                this.waiting.add(client);
                await client.send(
                    new ReliablePacket(
                        client.getNextNonce(),
                        [
                            new WaitForHostMessage(
                                this.code,
                                client.clientid
                            )
                        ]
                    )
                )
                return;
            }
        }

        await client.send(
            new ReliablePacket(
                client.getNextNonce(),
                [
                    new JoinedGameMessage(
                        this.code,
                        client.clientid,
                        this.host!.id,
                        [...this.clients]
                            .map(([, client]) => client.clientid)
                    )
                ]
            )
        );

        await this.broadcast([], true, null, [
            new JoinGameMessage(
                this.code,
                client.clientid,
                this.host!.id
            )
        ]);
        
        this.clients.set(client.clientid, client);

        this.logger.info(
            "%s joined the game.",
            fmtClient(client)
        );
    }

    async handleStart() {
        this.state = GameState.Started;

        await this.broadcast([], true, null, [
            new StartGameMessage(this.code)
        ]);
    }

    async handleEnd(reason: GameOverReason) {
        this.waiting.clear();
        this.state = GameState.Ended;

        await this.broadcast([], true, null, [
            new EndGameMessage(this.code, reason, false)
        ]);
    }
}