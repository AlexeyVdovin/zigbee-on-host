import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/utils/logger.js";
import { MACAssociationStatus, type MACCapabilities, type MACHeader, ZigbeeMACConsts } from "../../src/zigbee/mac.js";
import { makeKeyedHashByType, registerDefaultHashedKeys, ZigbeeConsts, ZigbeeKeyType } from "../../src/zigbee/zigbee.js";
import { ZigbeeNWKCommandId, ZigbeeNWKConsts, type ZigbeeNWKHeader } from "../../src/zigbee/zigbee-nwk.js";
import { MACHandler, type MACHandlerCallbacks } from "../../src/zigbee-stack/mac-handler.js";
import { NWKHandler, type NWKHandlerCallbacks } from "../../src/zigbee-stack/nwk-handler.js";
import { type NetworkParameters, StackContext, type StackContextCallbacks } from "../../src/zigbee-stack/stack-context.js";

describe("NWK Handler", () => {
    let saveDir: string;
    let nwkHandler: NWKHandler;
    let mockStackContextCallbacks: StackContextCallbacks;
    let mockContext: StackContext;
    let mockMACCallbacks: MACHandlerCallbacks;
    let mockMACHandler: MACHandler;
    let mockCallbacks: NWKHandlerCallbacks;
    let netParams: NetworkParameters;
    let associateSpy: MockInstance<StackContext["associate"]>;
    let sendFrameSpy: MockInstance<MACHandler["sendFrame"]>;

    beforeEach(() => {
        // Register default hashed keys for encryption/decryption
        const networkKey = Buffer.from("01030507090b0d0f00020406080a0c0d", "hex");
        const tcKey = Buffer.from("5a6967426565416c6c69616e63653039", "hex");
        registerDefaultHashedKeys(
            makeKeyedHashByType(ZigbeeKeyType.LINK, tcKey),
            makeKeyedHashByType(ZigbeeKeyType.NWK, networkKey),
            makeKeyedHashByType(ZigbeeKeyType.TRANSPORT, tcKey),
            makeKeyedHashByType(ZigbeeKeyType.LOAD, tcKey),
        );

        netParams = {
            eui64: 0x00124b0012345678n,
            panId: 0x1a62,
            extendedPanId: 0xdddddddddddddddn,
            channel: 15,
            nwkUpdateId: 0,
            txPower: 5,
            networkKey: Buffer.from("01030507090b0d0f00020406080a0c0d", "hex"),
            networkKeyFrameCounter: 0,
            networkKeySequenceNumber: 0,
            tcKey: Buffer.from("abcdabcdabcdabcdabcdabcdabcdabcd", "hex"),
            tcKeyFrameCounter: 0,
        };

        saveDir = `temp_NWKHandler_${Math.floor(Math.random() * 1000000)}`;
        mkdirSync(saveDir, { recursive: true });

        mockStackContextCallbacks = {
            onDeviceLeft: vi.fn(),
        };

        mockContext = new StackContext(mockStackContextCallbacks, join(saveDir, "zoh.save"), netParams);

        // Spy on context methods to track calls while preserving functionality
        vi.spyOn(mockContext, "nextNWKKeyFrameCounter");
        vi.spyOn(mockContext, "nextTCKeyFrameCounter");
        associateSpy = vi.spyOn(mockContext, "associate").mockResolvedValue([MACAssociationStatus.SUCCESS, 0x1234, false]);
        vi.spyOn(mockContext, "disassociate").mockResolvedValue(undefined);

        mockMACCallbacks = {
            onFrame: vi.fn(),
            onSendFrame: vi.fn().mockResolvedValue(undefined),
            onAPSSendTransportKeyNWK: vi.fn().mockResolvedValue(undefined),
            onMarkRouteSuccess: vi.fn(),
            onMarkRouteFailure: vi.fn(),
        };

        mockMACHandler = new MACHandler(mockContext, mockMACCallbacks, 99999);

        // Spy on MACHandler methods to track calls
        vi.spyOn(mockMACHandler, "nextSeqNum");
        sendFrameSpy = vi.spyOn(mockMACHandler, "sendFrame");
        vi.spyOn(mockMACHandler, "sendFrameDirect");

        mockCallbacks = {
            onAPSSendTransportKeyNWK: vi.fn(async () => {}),
        };

        nwkHandler = new NWKHandler(mockContext, mockMACHandler, mockCallbacks);

        vi.spyOn(nwkHandler, "nextSeqNum");
        vi.spyOn(nwkHandler, "nextRouteRequestId");
    });

    afterEach(() => {
        rmSync(saveDir, { force: true, recursive: true });
    });

    describe("nextNWKSeqNum", () => {
        it("should start at 1 and increment", () => {
            expect(nwkHandler.nextSeqNum()).toStrictEqual(1);
            expect(nwkHandler.nextSeqNum()).toStrictEqual(2);
            expect(nwkHandler.nextSeqNum()).toStrictEqual(3);
        });

        it("should wrap at 255", () => {
            for (let i = 0; i < 254; i++) {
                nwkHandler.nextSeqNum();
            }

            expect(nwkHandler.nextSeqNum()).toStrictEqual(255);
            expect(nwkHandler.nextSeqNum()).toStrictEqual(0);
            expect(nwkHandler.nextSeqNum()).toStrictEqual(1);
        });
    });

    describe("nextRouteRequestId", () => {
        it("should start at 1 and increment", () => {
            expect(nwkHandler.nextRouteRequestId()).toStrictEqual(1);
            expect(nwkHandler.nextRouteRequestId()).toStrictEqual(2);
            expect(nwkHandler.nextRouteRequestId()).toStrictEqual(3);
        });

        it("should wrap at 255", () => {
            for (let i = 0; i < 254; i++) {
                nwkHandler.nextRouteRequestId();
            }

            expect(nwkHandler.nextRouteRequestId()).toStrictEqual(255);
            expect(nwkHandler.nextRouteRequestId()).toStrictEqual(0);
            expect(nwkHandler.nextRouteRequestId()).toStrictEqual(1);
        });
    });

    describe("Route Management", () => {
        it("should find best source route", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            // Add address mapping
            mockContext.address16ToAddress64.set(device16, device64);

            // Add some routes
            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x0001, 0x0002],
                    pathCost: 3,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: undefined,
                },
                {
                    relayAddresses: [0x0003],
                    pathCost: 2,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: Date.now() - 1000,
                },
            ]);

            const [relayIndex, relayAddresses] = nwkHandler.findBestSourceRoute(device16, device64);

            // Should prefer recently used route with lower cost
            expect(relayIndex).toStrictEqual(0);
            expect(relayAddresses).toEqual([0x0003]);
        });

        it("does not reorder the source route table when a lookup prunes an entry", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            mockContext.address16ToAddress64.set(device16, device64);

            // Insertion order: the expired entry first, then a costly direct path, then a
            // cheap relayed one. Filtering drops the first, which is what makes
            // `findBestSourceRoute` write the survivors back to the table.
            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x00aa],
                    pathCost: 2,
                    lastUpdated: Date.now() - 11 * 60 * 1000, // expired
                    failureCount: 0,
                    lastUsed: undefined,
                },
                {
                    relayAddresses: [],
                    pathCost: 5,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: undefined,
                },
                {
                    relayAddresses: [0x00bb],
                    pathCost: 1,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: undefined,
                },
            ]);

            const [, relayAddresses] = nwkHandler.findBestSourceRoute(device16, device64);

            // The cheapest entry is chosen even though it is last in the table.
            expect(relayAddresses).toEqual([0x00bb]);

            // ...and the table still holds the survivors in insertion order. A read path
            // must not reorder state that `Mgmt_Rtg_rsp` reports verbatim.
            const stored = mockContext.sourceRouteTable.get(device16)!;

            expect(stored.map((e) => e.pathCost)).toStrictEqual([5, 1]);
        });

        it("returns the same table order on repeated lookups", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            mockContext.address16ToAddress64.set(device16, device64);

            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x00aa],
                    pathCost: 9,
                    lastUpdated: Date.now() - 11 * 60 * 1000, // expired, forces the write-back
                    failureCount: 0,
                    lastUsed: undefined,
                },
                {
                    relayAddresses: [0x00cc],
                    pathCost: 4,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: undefined,
                },
                {
                    relayAddresses: [],
                    pathCost: 1,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: undefined,
                },
            ]);

            nwkHandler.findBestSourceRoute(device16, device64);
            const afterFirst = mockContext.sourceRouteTable.get(device16)!.map((e) => e.pathCost);

            nwkHandler.findBestSourceRoute(device16, device64);
            const afterSecond = mockContext.sourceRouteTable.get(device16)!.map((e) => e.pathCost);

            expect(afterFirst).toStrictEqual([4, 1]);
            expect(afterSecond).toStrictEqual(afterFirst);
        });

        it("keeps the earlier entry when two routes score equally", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            mockContext.address16ToAddress64.set(device16, device64);

            // Same cost, same age, no failures: the tie must break on table order, which is
            // what the stable sort used to do.
            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x0011],
                    pathCost: 2,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: undefined,
                },
                {
                    relayAddresses: [0x0022],
                    pathCost: 2,
                    lastUpdated: Date.now(),
                    failureCount: 0,
                    lastUsed: undefined,
                },
            ]);

            const [, relayAddresses] = nwkHandler.findBestSourceRoute(device16, device64);

            expect(relayAddresses).toEqual([0x0011]);
        });

        it("should filter expired routes", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            // Add address mapping
            mockContext.address16ToAddress64.set(device16, device64);

            // Add expired route (> 10 minutes old)
            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x0001],
                    pathCost: 2,
                    lastUpdated: Date.now() - 11 * 60 * 1000, // 11 minutes ago
                    failureCount: 0,
                    lastUsed: undefined,
                },
            ]);

            const [relayIndex, relayAddresses] = nwkHandler.findBestSourceRoute(device16, device64);

            // Should not find expired route
            expect(relayIndex).toBeUndefined();
            expect(relayAddresses).toBeUndefined();
        });

        it("should filter blacklisted routes", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            // Add address mapping
            mockContext.address16ToAddress64.set(device16, device64);

            // Add route with high failure count
            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x0001],
                    pathCost: 2,
                    lastUpdated: Date.now(),
                    failureCount: 3, // >= MAX_FAILURES
                    lastUsed: undefined,
                },
            ]);

            const [relayIndex, relayAddresses] = nwkHandler.findBestSourceRoute(device16, device64);

            // Should not find blacklisted route
            expect(relayIndex).toBeUndefined();
            expect(relayAddresses).toBeUndefined();
        });

        it("should mark route success", () => {
            const device16 = 0x1234;

            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x0001],
                    pathCost: 2,
                    lastUpdated: Date.now(),
                    failureCount: 2,
                    lastUsed: undefined,
                },
            ]);

            nwkHandler.markRouteSuccess(device16);

            const routes = mockContext.sourceRouteTable.get(device16)!;
            expect(routes[0].failureCount).toStrictEqual(0);
            expect(routes[0].lastUsed).toBeDefined();
        });

        it("records success against the selected route, not the first one held", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0000001234n;

            mockContext.address16ToAddress64.set(device16, device64);

            // an inferred relayed path was installed first, then the device reported a direct one
            const relayed = nwkHandler.createSourceRouteEntry([0x0001], 2);
            const direct = nwkHandler.createSourceRouteEntry([], 1);

            mockContext.sourceRouteTable.set(device16, [relayed, direct]);

            // the cheaper path is the one that carries the frame
            expect(nwkHandler.findBestSourceRoute(device16, undefined)[1]).toBeUndefined();

            nwkHandler.markRouteSuccess(device16);

            expect(direct.lastUsed).toBeDefined();
            expect(direct.failureCount).toStrictEqual(0);
            expect(relayed.lastUsed).toBeUndefined();

            // table order is untouched: it is reported verbatim in Mgmt_Rtg_rsp
            expect(mockContext.sourceRouteTable.get(device16)).toStrictEqual([relayed, direct]);
        });

        it("does not clear a blacklisted route when the frame went direct as a last resort", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0000001234n;

            mockContext.address16ToAddress64.set(device16, device64);

            const blacklisted = nwkHandler.createSourceRouteEntry([0x0001], 2);

            blacklisted.failureCount = 3;
            mockContext.sourceRouteTable.set(device16, [blacklisted]);

            // nothing is selectable, so the frame was sent direct; its success says nothing
            // about the stored path
            nwkHandler.markRouteSuccess(device16);

            expect(blacklisted.failureCount).toStrictEqual(3);
            expect(blacklisted.lastUsed).toBeUndefined();
        });

        it("records failure against the selected route, not the first one held", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0000001234n;

            mockContext.address16ToAddress64.set(device16, device64);

            const relayed = nwkHandler.createSourceRouteEntry([0x0001], 2);
            const direct = nwkHandler.createSourceRouteEntry([], 1);

            mockContext.sourceRouteTable.set(device16, [relayed, direct]);

            nwkHandler.markRouteFailure(device16);

            expect(direct.failureCount).toStrictEqual(1);
            expect(relayed.failureCount).toStrictEqual(0);
        });

        it("should mark route failure and trigger MTORR", async () => {
            const sendPeriodicManyToOneRouteRequestSpy = vi.spyOn(nwkHandler, "sendPeriodicManyToOneRouteRequest");
            const device16 = 0x1234;

            mockContext.sourceRouteTable.set(device16, [
                {
                    relayAddresses: [0x0001],
                    pathCost: 2,
                    lastUpdated: Date.now(),
                    failureCount: 2,
                    lastUsed: undefined,
                },
            ]);

            nwkHandler.markRouteFailure(device16, true);

            // Wait for setImmediate callback to execute
            await new Promise((resolve) => setImmediate(resolve));

            // Should trigger MTORR
            expect(sendPeriodicManyToOneRouteRequestSpy).toHaveBeenCalled();

            // Route should be purged (blacklisted with failureCount >= 3)
            const routes = mockContext.sourceRouteTable.get(device16);
            expect(routes).toBeUndefined();
        });
    });

    describe("Targeted route discovery", () => {
        const child16 = 0x268f;
        const child64 = 0x00124b00aabb0001n;
        const parent16 = 0x661e;
        let requestSpy: MockInstance<NWKHandler["sendRouteReq"]>;

        function addChild(neighbor: boolean): void {
            mockContext.deviceTable.set(child64, {
                address16: child16,
                capabilities: {
                    alternatePANCoordinator: false,
                    deviceType: 0,
                    powerSource: 0,
                    rxOnWhenIdle: false,
                    securityCapability: true,
                    allocateAddress: true,
                },
                authorized: true,
                neighbor,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });
            mockContext.address16ToAddress64.set(child16, child64);
        }

        beforeEach(() => {
            vi.useFakeTimers();
            vi.spyOn(nwkHandler, "sendPeriodicManyToOneRouteRequest").mockResolvedValue();
            requestSpy = vi.spyOn(nwkHandler, "sendRouteReq").mockResolvedValue(true);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("asks for a route to a device that is not a neighbour and has none", () => {
            addChild(false);

            const [relayIndex, relays] = nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();

            expect(relayIndex).toBeUndefined();
            expect(relays).toBeUndefined();
            // many-to-one disabled (0), for the device's own address
            expect(requestSpy).toHaveBeenCalledTimes(1);
            expect(requestSpy).toHaveBeenCalledWith(0, child16);
        });

        it("asks again when the route a reply gave it has expired", () => {
            addChild(false);
            // a sleepy end device's own relayed source routes do not age out; a next hop from a route reply does
            const expired = nwkHandler.createSourceRouteEntry([parent16], 2);
            expired.nextHopOnly = true;
            expired.lastUpdated = Date.now() - 310000;
            mockContext.sourceRouteTable.set(child16, [expired]);

            nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();

            expect(requestSpy).toHaveBeenCalledTimes(1);
            expect(requestSpy).toHaveBeenCalledWith(0, child16);
        });

        it("asks again when every route to it is blacklisted", () => {
            addChild(false);
            const failing = nwkHandler.createSourceRouteEntry([parent16], 2);
            failing.failureCount = 3;
            mockContext.sourceRouteTable.set(child16, [failing]);

            nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();

            expect(requestSpy).toHaveBeenCalledTimes(1);
            expect(requestSpy).toHaveBeenCalledWith(0, child16);
        });

        it("asks at most once per nwkcRouteDiscoveryTime for one device", () => {
            addChild(false);

            nwkHandler.findBestSourceRoute(child16, child64);
            nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();
            expect(requestSpy).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(9000);
            nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();
            expect(requestSpy).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(1000);
            nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();
            expect(requestSpy).toHaveBeenCalledTimes(2);
        });

        it("does not ask for a route to a neighbour", () => {
            addChild(true);

            nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();

            expect(requestSpy).not.toHaveBeenCalled();
        });

        it("does not ask while a usable route exists", () => {
            addChild(false);
            mockContext.sourceRouteTable.set(child16, [nwkHandler.createSourceRouteEntry([parent16], 2)]);

            const [relayIndex, relays] = nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();

            expect(relayIndex).toStrictEqual(0);
            expect(relays).toStrictEqual([parent16]);
            expect(requestSpy).not.toHaveBeenCalled();
        });

        it("stores a route reply sent on a child's behalf as the next hop through its parent", () => {
            addChild(false);
            const payload = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_REPLY,
                0x00, // options
                0x21, // route request id
                ZigbeeConsts.COORDINATOR_ADDRESS & 0xff,
                (ZigbeeConsts.COORDINATOR_ADDRESS >> 8) & 0xff,
                child16 & 0xff, // responder: the child, answered for by its parent
                (child16 >> 8) & 0xff,
                0x02, // path cost
            ]);

            nwkHandler.processRouteReply(
                payload,
                1,
                { frameControl: {}, source16: parent16, sequenceNumber: 30 } as MACHeader,
                {
                    frameControl: {},
                    source16: parent16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    relayAddresses: undefined,
                    seqNum: 31,
                } as ZigbeeNWKHeader,
            );

            const route = nwkHandler.findBestSourceRoute(child16, child64);
            vi.runAllTimers();

            expect(route).toStrictEqual([undefined, undefined, 2, parent16]);
            expect(requestSpy).not.toHaveBeenCalled();
        });

        it("does not answer a route request that comes back from the coordinator itself", async () => {
            const routeRequest = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_REQ,
                0x00, // options: not many-to-one
                10, // id
                0x78,
                0x56, // destination16, a unicast address
                0, // pathCost
            ]);
            const headersFrom = (nwkSource16: number, macSource16: number): [MACHeader, ZigbeeNWKHeader] => [
                {
                    frameControl: {
                        frameType: 1,
                        securityEnabled: false,
                        framePending: false,
                        ackRequest: true,
                        panIdCompression: true,
                        seqNumSuppress: false,
                        iePresent: false,
                        destAddrMode: 2,
                        frameVersion: 0,
                        sourceAddrMode: 2,
                    },
                    sequenceNumber: 1,
                    destinationPANId: 0x1a62,
                    destination16: ZigbeeConsts.BCAST_DEFAULT,
                    source16: macSource16,
                    fcs: 0,
                },
                {
                    frameControl: {
                        frameType: 1,
                        protocolVersion: 2,
                        discoverRoute: 0,
                        multicast: false,
                        security: false,
                        sourceRoute: false,
                        extendedDestination: false,
                        extendedSource: false,
                        endDeviceInitiator: false,
                    },
                    destination16: ZigbeeConsts.BCAST_DEFAULT,
                    source16: nwkSource16,
                    radius: 10,
                    seqNum: 5,
                },
            ];
            mockContext.address16ToAddress64.set(0x1234, 0x00124b0012345678n);
            // the router that repeats our broadcast is a known device: a reply to it could be sent
            mockContext.address16ToAddress64.set(parent16, 0x00124b00aabb0002n);
            sendFrameSpy.mockClear();

            // a router repeats our broadcast: the NWK source stays the coordinator, the MAC source is the router
            const [echoMac, echoNwk] = headersFrom(ZigbeeConsts.COORDINATOR_ADDRESS, parent16);
            await nwkHandler.processCommand(routeRequest, echoMac, echoNwk);

            expect(sendFrameSpy).not.toHaveBeenCalled();

            // the same request from a router is answered, so the check above is not vacuous
            const [routerMac, routerNwk] = headersFrom(0x1234, 0x1234);
            await nwkHandler.processCommand(routeRequest, routerMac, routerNwk);

            expect(sendFrameSpy).toHaveBeenCalled();
        });
    });

    describe("NWK Command Sending", () => {
        it("should send route request command", async () => {
            const result = await nwkHandler.sendRouteReq(0, 0x1234, 0x00124b0012345678n);

            expect(result).toStrictEqual(true);
            expect(nwkHandler.nextRouteRequestId).toHaveBeenCalled();
            expect(nwkHandler.nextSeqNum).toHaveBeenCalled();
            expect(mockMACHandler.nextSeqNum).toHaveBeenCalled();
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should send route reply command", async () => {
            // Add address mappings for the test
            mockContext.address16ToAddress64.set(0x0001, 0x00124b0000000001n);
            mockContext.address16ToAddress64.set(0x1234, 0x00124b0012345678n);
            mockContext.address16ToAddress64.set(0x5678, 0x00124b0056780000n);

            const result = await nwkHandler.sendRouteReply(0x0001, 10, 5, 0x1234, 0x5678, 0x00124b0012345678n, 0x00124b0087654321n);

            expect(result).toStrictEqual(true);
            expect(nwkHandler.nextSeqNum).toHaveBeenCalled();
            expect(mockMACHandler.nextSeqNum).toHaveBeenCalled();
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should send network status command", async () => {
            // Add address mapping for the destination
            mockContext.address16ToAddress64.set(0x1234, 0x00124b0012345678n);

            const result = await nwkHandler.sendStatus(0x1234, 0x00);

            expect(result).toStrictEqual(true);
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should send leave command", async () => {
            mockContext.address16ToAddress64.set(0x1234, 0x00124b0012345678n);

            const result = await nwkHandler.sendLeave(0x1234, false);

            expect(result).toStrictEqual(true);
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should send link status command", async () => {
            await nwkHandler.sendLinkStatus([]);

            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });
    });

    describe("NWK Command Processing", () => {
        it("should process route request", async () => {
            const macHeader: MACHeader = {
                frameControl: {
                    frameType: 1,
                    securityEnabled: false,
                    framePending: false,
                    ackRequest: true,
                    panIdCompression: true,
                    seqNumSuppress: false,
                    iePresent: false,
                    destAddrMode: 2,
                    frameVersion: 0,
                    sourceAddrMode: 2,
                },
                sequenceNumber: 1,
                destinationPANId: 0x1a62,
                destination16: ZigbeeConsts.BCAST_DEFAULT,
                source16: 0x1234,
                fcs: 0,
            };

            const nwkHeader: ZigbeeNWKHeader = {
                frameControl: {
                    frameType: 1,
                    protocolVersion: 2,
                    discoverRoute: 0,
                    multicast: false,
                    security: false,
                    sourceRoute: false,
                    extendedDestination: false,
                    extendedSource: false,
                    endDeviceInitiator: false,
                },
                destination16: ZigbeeConsts.BCAST_DEFAULT,
                source16: 0x1234,
                radius: 10,
                seqNum: 5,
            };

            const payload = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_REQ,
                0x00, // options
                10, // id
                0x78,
                0x56, // destination16
                0, // pathCost
            ]);

            mockContext.address16ToAddress64.set(0x1234, 0x00124b0012345678n);

            await nwkHandler.processCommand(payload, macHeader, nwkHeader);

            // Should have sent route reply
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should process leave request", async () => {
            const macHeader: MACHeader = {
                frameControl: {
                    frameType: 1,
                    securityEnabled: false,
                    framePending: false,
                    ackRequest: true,
                    panIdCompression: true,
                    seqNumSuppress: false,
                    iePresent: false,
                    destAddrMode: 2,
                    frameVersion: 0,
                    sourceAddrMode: 2,
                },
                sequenceNumber: 1,
                destinationPANId: 0x1a62,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: 0x1234,
                source64: 0x00124b0012345678n,
                fcs: 0,
            };

            const nwkHeader: ZigbeeNWKHeader = {
                frameControl: {
                    frameType: 1,
                    protocolVersion: 2,
                    discoverRoute: 0,
                    multicast: false,
                    security: false,
                    sourceRoute: false,
                    extendedDestination: false,
                    extendedSource: false,
                    endDeviceInitiator: false,
                },
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: 0x1234,
                source64: 0x00124b0012345678n,
                radius: 1,
                seqNum: 5,
            };

            const payload = Buffer.from([
                ZigbeeNWKCommandId.LEAVE,
                0x00, // options (not rejoin, not request)
            ]);

            await nwkHandler.processCommand(payload, macHeader, nwkHeader);

            // Should have called disassociate callback
            expect(mockContext.disassociate).toHaveBeenCalledWith(0x1234, 0x00124b0012345678n);
        });

        it("should process route record", () => {
            const macHeader: MACHeader = {
                frameControl: {
                    frameType: 1,
                    securityEnabled: false,
                    framePending: false,
                    ackRequest: true,
                    panIdCompression: true,
                    seqNumSuppress: false,
                    iePresent: false,
                    destAddrMode: 2,
                    frameVersion: 0,
                    sourceAddrMode: 2,
                },
                sequenceNumber: 1,
                destinationPANId: 0x1a62,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: 0x1234,
                source64: 0x00124b0012345678n,
                fcs: 0,
            };

            const nwkHeader: ZigbeeNWKHeader = {
                frameControl: {
                    frameType: 1,
                    protocolVersion: 2,
                    discoverRoute: 0,
                    multicast: false,
                    security: false,
                    sourceRoute: false,
                    extendedDestination: false,
                    extendedSource: false,
                    endDeviceInitiator: false,
                },
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: 0x1234,
                source64: 0x00124b0012345678n,
                radius: 10,
                seqNum: 5,
            };

            const payload = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_RECORD,
                2, // relay count
                0x01,
                0x00, // relay 1
                0x02,
                0x00, // relay 2
            ]);

            nwkHandler.processCommand(payload, macHeader, nwkHeader);

            // Should have stored source route
            const routes = mockContext.sourceRouteTable.get(0x1234);
            expect(routes).toBeDefined();
            expect(routes![0].relayAddresses).toEqual([0x0001, 0x0002]);
            expect(routes![0].pathCost).toStrictEqual(3); // relayCount + 1
        });

        it("ignores route record when addressing is missing", () => {
            const initialSize = mockContext.sourceRouteTable.size;

            nwkHandler.processCommand(
                Buffer.from([ZigbeeNWKCommandId.ROUTE_RECORD, 0x00]),
                {
                    frameControl: {},
                    source16: 0x2001,
                    sequenceNumber: 7,
                } as MACHeader,
                {
                    frameControl: {
                        frameType: 1,
                        protocolVersion: 2,
                        discoverRoute: 0,
                        multicast: false,
                        security: false,
                        sourceRoute: false,
                        extendedDestination: false,
                        extendedSource: false,
                        endDeviceInitiator: false,
                    },
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    source16: undefined,
                    source64: undefined,
                    radius: 1,
                    seqNum: 8,
                } as ZigbeeNWKHeader,
            );

            expect(mockContext.sourceRouteTable.size).toStrictEqual(initialSize);
        });
    });

    describe("Rejoin Handling", () => {
        it("should process rejoin request and call associate callback", async () => {
            const macHeader: MACHeader = {
                frameControl: {
                    frameType: 1,
                    securityEnabled: false,
                    framePending: false,
                    ackRequest: true,
                    panIdCompression: true,
                    seqNumSuppress: false,
                    iePresent: false,
                    destAddrMode: 2,
                    frameVersion: 0,
                    sourceAddrMode: 2,
                },
                sequenceNumber: 1,
                destinationPANId: 0x1a62,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: 0x1234,
                source64: 0x00124b0012345678n,
                fcs: 0,
            };

            const nwkHeader: ZigbeeNWKHeader = {
                frameControl: {
                    frameType: 1,
                    protocolVersion: 2,
                    discoverRoute: 0,
                    multicast: false,
                    security: false,
                    sourceRoute: false,
                    extendedDestination: false,
                    extendedSource: true,
                    endDeviceInitiator: false,
                },
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: 0x1234,
                source64: 0x00124b0012345678n,
                radius: 10,
                seqNum: 5,
            };

            const payload = Buffer.from([
                ZigbeeNWKCommandId.REJOIN_REQ,
                0x8e, // capabilities
            ]);

            mockContext.address16ToAddress64.set(0x1234, 0x00124b0012345678n);

            await nwkHandler.processCommand(payload, macHeader, nwkHeader);

            // Should have called associate callback
            expect(associateSpy).toHaveBeenCalledWith(
                0x1234,
                0x00124b0012345678n,
                false, // rejoin (not initial join)
                expect.objectContaining({
                    deviceType: 1,
                    rxOnWhenIdle: true,
                    allocateAddress: true,
                }), // capabilities
                true, // neighbor
                true, // denyOverride (security is implicitly false, checks source64 vs trusted center)
            );

            // Should have sent rejoin response
            expect(sendFrameSpy).toHaveBeenCalled();
        });

        it("drops rejoin request without source addressing", async () => {
            associateSpy.mockClear();
            sendFrameSpy.mockClear();

            const offset = await nwkHandler.processRejoinReq(
                Buffer.from([0x8e]),
                0,
                {
                    frameControl: {},
                    sequenceNumber: 0,
                } as MACHeader,
                {
                    frameControl: {
                        frameType: 1,
                        protocolVersion: 2,
                        discoverRoute: 0,
                        multicast: false,
                        security: false,
                        sourceRoute: false,
                        extendedDestination: false,
                        extendedSource: false,
                        endDeviceInitiator: false,
                    },
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    source16: undefined,
                    source64: undefined,
                    radius: 1,
                    seqNum: 6,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(1);
            expect(associateSpy).not.toHaveBeenCalled();
            expect(sendFrameSpy).not.toHaveBeenCalled();
        });

        it("denies unsecured rejoin when IEEE address is unknown", async () => {
            associateSpy.mockClear();

            await nwkHandler.processRejoinReq(
                Buffer.from([0x8e]),
                0,
                {
                    frameControl: {},
                    source16: 0x2002,
                    sequenceNumber: 2,
                } as MACHeader,
                {
                    frameControl: {
                        frameType: 1,
                        protocolVersion: 2,
                        discoverRoute: 0,
                        multicast: false,
                        security: false,
                        sourceRoute: false,
                        extendedDestination: false,
                        extendedSource: false,
                        endDeviceInitiator: false,
                    },
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    source16: 0x2002,
                    source64: undefined,
                    radius: 1,
                    seqNum: 9,
                } as ZigbeeNWKHeader,
            );

            expect(associateSpy).toHaveBeenCalled();
            expect(associateSpy.mock.calls[0]?.[5]).toStrictEqual(true);
        });
    });

    describe("Link Status Processing", () => {
        it("should process link status and update source routes", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            mockContext.deviceTable.set(device64, {
                address16: device16,
                authorized: true,
                capabilities: {
                    alternatePANCoordinator: false,
                    deviceType: 1,
                    powerSource: 1,
                    rxOnWhenIdle: true,
                    securityCapability: true,
                    allocateAddress: true,
                },
                neighbor: false,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [255],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });

            const macHeader: MACHeader = {
                frameControl: {
                    frameType: 1,
                    securityEnabled: false,
                    framePending: false,
                    ackRequest: true,
                    panIdCompression: true,
                    seqNumSuppress: false,
                    iePresent: false,
                    destAddrMode: 2,
                    frameVersion: 0,
                    sourceAddrMode: 2,
                },
                sequenceNumber: 1,
                destinationPANId: 0x1a62,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: device16,
                source64: device64,
                fcs: 0,
            };

            const nwkHeader: ZigbeeNWKHeader = {
                frameControl: {
                    frameType: 1,
                    protocolVersion: 2,
                    discoverRoute: 0,
                    multicast: false,
                    security: false,
                    sourceRoute: false,
                    extendedDestination: false,
                    extendedSource: true,
                    endDeviceInitiator: false,
                },
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: device16,
                source64: device64,
                radius: 1,
                seqNum: 5,
            };

            const payload = Buffer.from([
                ZigbeeNWKCommandId.LINK_STATUS,
                0x61, // options: entry count = 1, first frame, last frame
                ZigbeeConsts.COORDINATOR_ADDRESS & 0xff,
                (ZigbeeConsts.COORDINATOR_ADDRESS >> 8) & 0xff,
                0x03, // incoming cost = 3, outgoing cost = 0
            ]);

            nwkHandler.processCommand(payload, macHeader, nwkHeader);

            // Should have created source route
            const routes = mockContext.sourceRouteTable.get(device16);
            expect(routes).toBeDefined();
            expect(routes![0].pathCost).toStrictEqual(3);
        });

        it("updates existing source route using address map during link status", () => {
            const device16 = 0x3344;
            const device64 = 0x00124b0011223344n;

            mockContext.address16ToAddress64.set(device16, device64);
            mockContext.deviceTable.set(device64, {
                address16: device16,
                authorized: true,
                capabilities: {
                    alternatePANCoordinator: false,
                    deviceType: 1,
                    powerSource: 1,
                    rxOnWhenIdle: true,
                    securityCapability: true,
                    allocateAddress: true,
                },
                neighbor: false,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });

            const existing = nwkHandler.createSourceRouteEntry([], 5);
            existing.pathCost = 5;
            existing.failureCount = 4;
            mockContext.sourceRouteTable.set(device16, [existing]);

            const payload = Buffer.from([
                0x21, // count=1, first frame=false, last frame=true
                ZigbeeConsts.COORDINATOR_ADDRESS & 0xff,
                (ZigbeeConsts.COORDINATOR_ADDRESS >> 8) & 0xff,
                0x02, // incoming cost=2
            ]);

            nwkHandler.processLinkStatus(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 6,
                } as MACHeader,
                {
                    frameControl: {
                        frameType: 1,
                        protocolVersion: 2,
                        discoverRoute: 0,
                        multicast: false,
                        security: false,
                        sourceRoute: false,
                        extendedDestination: false,
                        extendedSource: false,
                        endDeviceInitiator: false,
                    },
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    source16: device16,
                    source64: undefined,
                    radius: 1,
                    seqNum: 8,
                } as ZigbeeNWKHeader,
            );

            const refreshed = mockContext.sourceRouteTable.get(device16)?.[0];

            expect(refreshed?.pathCost).toStrictEqual(2);
            expect(refreshed?.failureCount).toStrictEqual(0);
            expect(mockContext.deviceTable.get(device64)?.neighbor).toStrictEqual(true);
        });

        describe("a neighbour's MAC NO_ACKs", () => {
            const relay16 = 0x5566;
            const relay64 = 0x00124b0055667788n;
            const far16 = 0x7788;
            const far64 = 0x00124b0077889900n;

            const router = (address16: number) => ({
                address16,
                authorized: true,
                capabilities: {
                    alternatePANCoordinator: false,
                    deviceType: 1,
                    powerSource: 1,
                    rxOnWhenIdle: true,
                    securityCapability: true,
                    allocateAddress: true,
                },
                neighbor: true,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });

            const linkStatusFrom = (entries: [number, number][]) => {
                const payload = Buffer.alloc(1 + entries.length * 3);
                payload.writeUInt8(0x60 | entries.length, 0); // first and last frame
                entries.forEach(([address, costByte], i) => {
                    payload.writeUInt16LE(address, 1 + i * 3);
                    payload.writeUInt8(costByte, 3 + i * 3);
                });

                nwkHandler.processLinkStatus(
                    payload,
                    0,
                    { frameControl: {}, source16: relay16, sequenceNumber: 1 } as MACHeader,
                    {
                        frameControl: {
                            frameType: 1,
                            protocolVersion: 2,
                            discoverRoute: 0,
                            multicast: false,
                            security: false,
                            sourceRoute: false,
                            extendedDestination: false,
                            extendedSource: false,
                            endDeviceInitiator: false,
                        },
                        destination16: ZigbeeConsts.BCAST_RX_ON_WHEN_IDLE,
                        source16: relay16,
                        source64: undefined,
                        radius: 1,
                        seqNum: 9,
                    } as ZigbeeNWKHeader,
                );
            };

            beforeEach(() => {
                mockContext.address16ToAddress64.set(relay16, relay64);
                mockContext.deviceTable.set(relay64, router(relay16));
                mockContext.address16ToAddress64.set(far16, far64);
                mockContext.deviceTable.set(far64, { ...router(far16), neighbor: false });
                mockContext.sourceRouteTable.set(far16, [nwkHandler.createSourceRouteEntry([relay16], 2)]);
                mockContext.macNoACKs.set(relay16, 2);
            });

            it("are forgotten when its link status says it hears the coordinator, so routes through it work again", () => {
                // the NO_ACKs reject the only route through it, and the lookup purges it
                expect(nwkHandler.findBestSourceRoute(far16, undefined)[1]).toBeUndefined();
                // a route reply brings the same path back, and it is rejected again
                mockContext.sourceRouteTable.set(far16, [nwkHandler.createSourceRouteEntry([relay16], 2)]);
                expect(nwkHandler.findBestSourceRoute(far16, undefined)[1]).toBeUndefined();

                mockContext.sourceRouteTable.set(far16, [nwkHandler.createSourceRouteEntry([relay16], 2)]);
                linkStatusFrom([[ZigbeeConsts.COORDINATOR_ADDRESS, 0x12]]); // incoming 2, outgoing 1

                expect(mockContext.macNoACKs.has(relay16)).toStrictEqual(false);
                expect(nwkHandler.findBestSourceRoute(far16, undefined)[1]).toStrictEqual([relay16]);
            });

            it("are kept when it lists the coordinator with no incoming cost", () => {
                linkStatusFrom([[ZigbeeConsts.COORDINATOR_ADDRESS, 0x30]]); // incoming 0, outgoing 3

                expect(mockContext.macNoACKs.get(relay16)).toStrictEqual(2);
            });

            it("are kept when its link status does not list the coordinator", () => {
                linkStatusFrom([[0x9999, 0x11]]);

                expect(mockContext.macNoACKs.get(relay16)).toStrictEqual(2);
            });
        });
    });

    describe("Link Status Relay Routes", () => {
        const relay16 = 0xfed8;
        const relay64 = 0x00124b0022334455n;
        const quiet16 = 0x4e1e;
        const quiet64 = 0x00124b0066778899n;

        const addDevice = (address16: number, address64: bigint) => {
            mockContext.address16ToAddress64.set(address16, address64);
            mockContext.deviceTable.set(address64, {
                address16,
                authorized: true,
                capabilities: {
                    alternatePANCoordinator: false,
                    deviceType: 1,
                    powerSource: 1,
                    rxOnWhenIdle: true,
                    securityCapability: true,
                    allocateAddress: true,
                },
                neighbor: false,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });
        };

        /** One link status frame from `sender16` listing `links` as [address, incomingCost, outgoingCost]. */
        const sendLinkStatus = (sender16: number, links: [number, number, number][]) => {
            const payload = Buffer.alloc(1 + links.length * 3);
            payload.writeUInt8(0x60 | links.length, 0); // first frame + last frame + count

            let offset = 1;

            for (const [address, incomingCost, outgoingCost] of links) {
                offset = payload.writeUInt16LE(address, offset);
                offset = payload.writeUInt8((incomingCost & 0x07) | ((outgoingCost & 0x07) << 4), offset);
            }

            nwkHandler.processLinkStatus(
                payload,
                0,
                { frameControl: {}, source16: sender16, sequenceNumber: 1 } as MACHeader,
                {
                    frameControl: {
                        frameType: 1,
                        protocolVersion: 2,
                        discoverRoute: 0,
                        multicast: false,
                        security: false,
                        sourceRoute: false,
                        extendedDestination: false,
                        extendedSource: false,
                        endDeviceInitiator: false,
                    },
                    destination16: ZigbeeConsts.BCAST_DEFAULT,
                    source16: sender16,
                    source64: undefined,
                    radius: 1,
                    seqNum: 1,
                } as ZigbeeNWKHeader,
            );
        };

        beforeEach(() => {
            addDevice(relay16, relay64);
            addDevice(quiet16, quiet64);
            // the relay is a coordinator neighbour: a direct, zero-relay route
            mockContext.sourceRouteTable.set(relay16, [nwkHandler.createSourceRouteEntry([], 1)]);
        });

        it("routes a quiet neighbour through the relay that reported it", () => {
            expect(mockContext.sourceRouteTable.get(quiet16)).toBeUndefined();

            sendLinkStatus(relay16, [
                [ZigbeeConsts.COORDINATOR_ADDRESS, 1, 2],
                [quiet16, 3, 1],
            ]);

            const entries = mockContext.sourceRouteTable.get(quiet16);

            expect(entries).toHaveLength(1);
            expect(entries?.[0].relayAddresses).toStrictEqual([relay16]);
            // the relay's own cost (1) plus the hop, costed at max(incoming 3, outgoing 1) per #3.6.4.5.1.2
            expect(entries?.[0].pathCost).toStrictEqual(4);

            // and it is usable, which is the whole point
            const [relayIndex, relayAddresses] = nwkHandler.findBestSourceRoute(quiet16, undefined);

            expect(relayAddresses).toStrictEqual([relay16]);
            expect(relayAddresses?.[relayIndex!]).toStrictEqual(relay16);
        });

        it("refreshes the route on every link status, so it cannot age out", () => {
            sendLinkStatus(relay16, [[quiet16, 3, 1]]);

            const entry = mockContext.sourceRouteTable.get(quiet16)?.[0];

            expect(entry).toBeDefined();

            // age it past expiry and mark it failing, as an unrefreshed route would be
            entry!.lastUpdated = Date.now() - 400000;
            entry!.failureCount = 2;

            sendLinkStatus(relay16, [[quiet16, 3, 1]]);

            const entries = mockContext.sourceRouteTable.get(quiet16);

            expect(entries).toHaveLength(1);
            expect(Date.now() - entries![0].lastUpdated).toBeLessThan(1000);
            expect(entries![0].failureCount).toStrictEqual(0);
        });

        it("records nothing when the outgoing cost is unknown", () => {
            // outgoing cost 0 means "no outgoing cost is available" (#3.6.1.7, Table 3-71), not "free"
            sendLinkStatus(relay16, [[quiet16, 7, 0]]);

            expect(mockContext.sourceRouteTable.get(quiet16)).toBeUndefined();
        });

        it("never routes the coordinator through anyone", () => {
            sendLinkStatus(relay16, [[ZigbeeConsts.COORDINATOR_ADDRESS, 1, 1]]);

            expect(mockContext.sourceRouteTable.get(ZigbeeConsts.COORDINATOR_ADDRESS)).toBeUndefined();
        });

        it("records nothing for a device it cannot name", () => {
            sendLinkStatus(relay16, [[0x9999, 1, 1]]);

            expect(mockContext.sourceRouteTable.get(0x9999)).toBeUndefined();
        });

        it("records nothing when the relay itself has no usable route", () => {
            mockContext.sourceRouteTable.delete(relay16);

            sendLinkStatus(relay16, [[quiet16, 3, 1]]);

            expect(mockContext.sourceRouteTable.get(quiet16)).toBeUndefined();
        });

        it("records nothing when the relay's own route has expired", () => {
            const stale = nwkHandler.createSourceRouteEntry([], 1);
            stale.lastUpdated = Date.now() - 400000;
            mockContext.sourceRouteTable.set(relay16, [stale]);

            sendLinkStatus(relay16, [[quiet16, 3, 1]]);

            expect(mockContext.sourceRouteTable.get(quiet16)).toBeUndefined();
        });

        it("extends a multi-hop relay path rather than replacing it", () => {
            const far16 = 0x8e8d;
            addDevice(far16, 0x00124b00ccddeeffn);
            // reaching the relay already takes one hop through 0x1111
            mockContext.sourceRouteTable.set(relay16, [nwkHandler.createSourceRouteEntry([0x1111], 3)]);

            sendLinkStatus(relay16, [[far16, 1, 2]]);

            const entry = mockContext.sourceRouteTable.get(far16)?.[0];

            expect(entry?.relayAddresses).toStrictEqual([0x1111, relay16]);
            expect(entry?.pathCost).toStrictEqual(5);
        });

        it("refuses a path that loops back through its own destination", () => {
            // we reach the relay *through* the quiet node; routing the quiet node back through the
            // relay would be a loop
            mockContext.sourceRouteTable.set(relay16, [nwkHandler.createSourceRouteEntry([quiet16], 3)]);

            sendLinkStatus(relay16, [[quiet16, 3, 1]]);

            expect(mockContext.sourceRouteTable.get(quiet16)).toBeUndefined();
        });

        it("leaves a better existing route in place", () => {
            // a direct route to the quiet node already exists and is cheaper
            mockContext.sourceRouteTable.set(quiet16, [nwkHandler.createSourceRouteEntry([], 1)]);

            sendLinkStatus(relay16, [[quiet16, 3, 1]]);

            const entries = mockContext.sourceRouteTable.get(quiet16);

            expect(entries).toHaveLength(2);

            // the cheaper direct route still wins
            const [, relayAddresses] = nwkHandler.findBestSourceRoute(quiet16, undefined);

            expect(relayAddresses).toBeUndefined();
        });
    });

    describe("Additional NWK Commands", () => {
        it("should process route reply", () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            mockContext.address16ToAddress64.set(device16, device64);

            const payload = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_REPLY,
                0x00, // options
                15, // route request ID
                ZigbeeConsts.COORDINATOR_ADDRESS & 0xff,
                (ZigbeeConsts.COORDINATOR_ADDRESS >> 8) & 0xff,
                device16 & 0xff,
                (device16 >> 8) & 0xff,
                0x05, // path cost = 5
            ]);

            const offset = nwkHandler.processRouteReply(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    source64: device64,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    source64: device64,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toBeGreaterThan(0);
        });

        it("refreshes an existing next hop entry when coordinator receives reply", () => {
            const responder16 = 0x2468;
            const nextHop = 0x3579;
            const existing = nwkHandler.createSourceRouteEntry([nextHop], 4);
            existing.nextHopOnly = true;
            existing.failureCount = 3;
            mockContext.sourceRouteTable.set(responder16, [existing]);
            const markSuccessSpy = vi.spyOn(nwkHandler, "markRouteSuccess");

            const payload = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_REPLY,
                0x00,
                0xaa,
                ZigbeeConsts.COORDINATOR_ADDRESS & 0xff,
                (ZigbeeConsts.COORDINATOR_ADDRESS >> 8) & 0xff,
                responder16 & 0xff,
                (responder16 >> 8) & 0xff,
                0x04,
            ]);

            nwkHandler.processRouteReply(
                payload,
                1,
                {
                    frameControl: {},
                    source16: nextHop,
                    sequenceNumber: 11,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: responder16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    relayAddresses: undefined,
                    seqNum: 12,
                } as ZigbeeNWKHeader,
            );

            const entries = mockContext.sourceRouteTable.get(responder16);
            expect(entries).toBeDefined();
            expect(entries?.length).toStrictEqual(1);
            expect(entries?.[0]).toBe(existing);
            expect(markSuccessSpy).toHaveBeenCalledWith(responder16);
            markSuccessSpy.mockRestore();

            const updated = entries?.[0];

            expect(updated?.failureCount).toStrictEqual(0);
            expect(existing.failureCount).toStrictEqual(0);
            expect(updated?.pathCost).toStrictEqual(4);
            expect(updated?.relayAddresses).toEqual([nextHop]);
        });

        it("keeps a source route through the router a reply came from apart from the next hop it brings", () => {
            const responder16 = 0x2468;
            const responder64 = 0x00124b0000002468n;
            const nextHop = 0x3579;
            mockContext.address16ToAddress64.set(responder16, responder64);
            const sourceRoute = nwkHandler.createSourceRouteEntry([nextHop], 2);
            mockContext.sourceRouteTable.set(responder16, [sourceRoute]);

            const payload = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_REPLY,
                0x00,
                0xab,
                ZigbeeConsts.COORDINATOR_ADDRESS & 0xff,
                (ZigbeeConsts.COORDINATOR_ADDRESS >> 8) & 0xff,
                responder16 & 0xff,
                (responder16 >> 8) & 0xff,
                0x06,
            ]);

            nwkHandler.processRouteReply(
                payload,
                1,
                { frameControl: {}, source16: nextHop, sequenceNumber: 13 } as MACHeader,
                {
                    frameControl: {},
                    source16: nextHop,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    relayAddresses: undefined,
                    seqNum: 14,
                } as ZigbeeNWKHeader,
            );

            const entries = mockContext.sourceRouteTable.get(responder16);

            expect(entries).toHaveLength(2);
            expect(entries?.[0]).toBe(sourceRoute);
            expect(sourceRoute.nextHopOnly).toBeUndefined();
            expect(entries?.[1].relayAddresses).toStrictEqual([nextHop]);
            expect(entries?.[1].nextHopOnly).toStrictEqual(true);
            // the source route is cheaper and wins
            expect(nwkHandler.findBestSourceRoute(responder16, responder64)).toStrictEqual([0, [nextHop], 2]);
        });

        it("stores a route reply from the responder itself as a direct route", () => {
            const responder16 = 0x2469;
            const responder64 = 0x00124b0000002469n;
            mockContext.address16ToAddress64.set(responder16, responder64);

            const payload = Buffer.from([
                ZigbeeNWKCommandId.ROUTE_REPLY,
                0x00,
                0xac,
                ZigbeeConsts.COORDINATOR_ADDRESS & 0xff,
                (ZigbeeConsts.COORDINATOR_ADDRESS >> 8) & 0xff,
                responder16 & 0xff,
                (responder16 >> 8) & 0xff,
                0x01,
            ]);

            nwkHandler.processRouteReply(
                payload,
                1,
                { frameControl: {}, source16: responder16, sequenceNumber: 15 } as MACHeader,
                {
                    frameControl: {},
                    source16: responder16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    relayAddresses: undefined,
                    seqNum: 16,
                } as ZigbeeNWKHeader,
            );

            const entries = mockContext.sourceRouteTable.get(responder16);

            expect(entries).toHaveLength(1);
            expect(entries?.[0].relayAddresses).toStrictEqual([]);
            expect(entries?.[0].nextHopOnly).toBeUndefined();
            expect(nwkHandler.findBestSourceRoute(responder16, responder64)).toStrictEqual([undefined, undefined, 1]);
        });

        it("stores a route record beside a next hop entry with the same relay and cost", async () => {
            const source16 = 0x246a;
            const source64 = 0x00124b000000246an;
            const nextHop = 0x3579;
            mockContext.address16ToAddress64.set(source16, source64);
            const nextHopEntry = nwkHandler.createSourceRouteEntry([nextHop], 2);
            nextHopEntry.nextHopOnly = true;
            mockContext.sourceRouteTable.set(source16, [nextHopEntry]);

            await nwkHandler.processCommand(
                Buffer.from([ZigbeeNWKCommandId.ROUTE_RECORD, 1, nextHop & 0xff, (nextHop >> 8) & 0xff]),
                { frameControl: {}, source16: nextHop, sequenceNumber: 17 } as MACHeader,
                {
                    frameControl: {},
                    source16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 18,
                } as ZigbeeNWKHeader,
            );

            const entries = mockContext.sourceRouteTable.get(source16);

            expect(entries).toHaveLength(2);
            expect(entries?.[1].relayAddresses).toStrictEqual([nextHop]);
            expect(entries?.[1].nextHopOnly).toBeUndefined();
        });

        it("should process network status", async () => {
            const device16 = 0x1234;
            const payload = Buffer.from([ZigbeeNWKCommandId.NWK_STATUS, 0x0b, 0x56, 0x34]);

            const offset = await nwkHandler.processStatus(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toBeGreaterThan(0);
        });

        it("should send network status", async () => {
            const device16 = 0x1234;
            mockContext.address16ToAddress64.set(device16, 0x00124b0012345678n);

            const result = await nwkHandler.sendStatus(device16, 0x01); // NOT_MEMBER

            expect(result).toStrictEqual(true);
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should process rejoin response", () => {
            const device16 = 0x1234;
            const payload = Buffer.from([device16 & 0xff, (device16 >> 8) & 0xff, MACAssociationStatus.SUCCESS]);

            const offset = nwkHandler.processRejoinResp(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(3);
        });

        it("should process end device timeout request", async () => {
            const device16 = 0x1234;
            const device64 = 0x00124b0012345678n;

            mockContext.address16ToAddress64.set(device16, device64);
            mockContext.deviceTable.set(device64, {
                address16: device16,
                capabilities: {
                    rxOnWhenIdle: false,
                    deviceType: 1,
                    alternatePANCoordinator: false,
                    powerSource: 0,
                    securityCapability: false,
                    allocateAddress: false,
                },
                authorized: true,
                neighbor: false,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });

            const payload = Buffer.from([ZigbeeNWKCommandId.ED_TIMEOUT_REQUEST, 0x04, 0x00]);

            const offset = await nwkHandler.processEdTimeoutRequest(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    source64: device64,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    source64: device64,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(2); // Command ID + requested timeout = 2 (config mask is not read)
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should process end device timeout response", () => {
            const device16 = 0x1234;
            const payload = Buffer.from([0x00, 0x04]);

            const offset = nwkHandler.processEdTimeoutResponse(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(2);
        });

        it("should send end device timeout response", async () => {
            const device16 = 0x1234;
            mockContext.address16ToAddress64.set(device16, 0x00124b0012345678n);

            const result = await nwkHandler.sendEdTimeoutResponse(device16, 4);

            expect(result).toStrictEqual(true);
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("reports unsupported end device timeout when IEEE mapping missing", async () => {
            const sendSpy = vi.spyOn(nwkHandler, "sendEdTimeoutResponse").mockResolvedValue(true);

            await nwkHandler.processEdTimeoutRequest(
                Buffer.from([0x01, 0x00]),
                0,
                {
                    frameControl: {},
                    source16: 0x4004,
                    sequenceNumber: 9,
                } as MACHeader,
                {
                    frameControl: {
                        frameType: 1,
                        protocolVersion: 2,
                        discoverRoute: 0,
                        multicast: false,
                        security: false,
                        sourceRoute: false,
                        extendedDestination: false,
                        extendedSource: false,
                        endDeviceInitiator: false,
                    },
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    source16: 0x4004,
                    source64: undefined,
                    radius: 1,
                    seqNum: 19,
                } as ZigbeeNWKHeader,
            );

            expect(sendSpy).toHaveBeenCalledWith(0x4004, 0x01, 0x02);
            sendSpy.mockRestore();
        });

        it("should process network report", () => {
            const device16 = 0x1234;
            // NWK Report needs: options + extended PAN ID (8 bytes) + (PANIDs if report type = 0)
            const payload = Buffer.from([
                0x00, // options: report count = 0, report type = 0 (PAN conflict)
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd, // extended PAN ID
                // No PAN IDs since count = 0
            ]);

            const offset = nwkHandler.processReport(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(9); // options (1) + extended PAN ID (8) = 9
        });

        it("logs network update without applying changes", () => {
            const device16 = 0x1234;
            // NWK Update needs: options + extended PAN ID + update ID + (PANIDs if update type = 0)
            const payload = Buffer.from([
                0x00, // options: update count = 0, update type = 0
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd, // extended PAN ID
                0x01, // update ID
                // No PAN IDs since count = 0
            ]);

            const saveSpy = vi.spyOn(mockContext, "savePeriodicState").mockResolvedValue();

            try {
                const offset = nwkHandler.processUpdate(
                    payload,
                    0,
                    {
                        frameControl: {},
                        source16: device16,
                        sequenceNumber: 10,
                    } as MACHeader,
                    {
                        frameControl: {},
                        source16: device16,
                        destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                        seqNum: 20,
                    } as ZigbeeNWKHeader,
                );

                expect(offset).toStrictEqual(10); // options (1) + extended PAN ID (8) + update ID (1) = 10
                expect(mockContext.netParams.nwkUpdateId).toStrictEqual(netParams.nwkUpdateId);
                expect(mockContext.netParams.panId).toStrictEqual(netParams.panId);
                expect(saveSpy).not.toHaveBeenCalled();
            } finally {
                saveSpy.mockRestore();
            }
        });

        it("ignores PAN ID updates announced by other devices", () => {
            const device16 = 0x1234;
            const payload = Buffer.from([
                0x01, // options: update count = 1, update type = 0 (PAN update)
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd,
                0xdd, // extended PAN ID
                0x02, // update ID (> current)
                0x44,
                0x33, // new PAN ID (little-endian)
            ]);

            const saveSpy = vi.spyOn(mockContext, "savePeriodicState").mockResolvedValue();

            try {
                nwkHandler.processUpdate(
                    payload,
                    0,
                    {
                        frameControl: {},
                        source16: device16,
                        sequenceNumber: 10,
                    } as MACHeader,
                    {
                        frameControl: {},
                        source16: device16,
                        destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                        seqNum: 20,
                    } as ZigbeeNWKHeader,
                );

                expect(mockContext.netParams.nwkUpdateId).toStrictEqual(netParams.nwkUpdateId);
                expect(mockContext.netParams.panId).toStrictEqual(netParams.panId);
                expect(saveSpy).not.toHaveBeenCalled();
            } finally {
                saveSpy.mockRestore();
            }
        });

        it("should process link power delta", () => {
            const device16 = 0x1234;
            const payload = Buffer.from([
                0x01, // options: type = 1 (request)
                0x01, // count = 1
                0x34,
                0x12,
                0x05,
            ]);

            const offset = nwkHandler.processLinkPwrDelta(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(5);
        });

        it("should process commissioning request", async () => {
            const device16 = 0x1234;
            const payload = Buffer.from([ZigbeeNWKCommandId.COMMISSIONING_REQUEST, 0x62, 0x1a, 15]);

            const offset = await nwkHandler.processCommissioningRequest(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(2); // Command ID + PAN ID (2 bytes) = 3, but channel not read
        });

        it("should process commissioning response", () => {
            const device16 = 0x1234;
            const payload = Buffer.from([0x34, 0x12, 0x00]);

            const offset = nwkHandler.processCommissioningResponse(
                payload,
                0,
                {
                    frameControl: {},
                    source16: device16,
                    sequenceNumber: 10,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: device16,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 20,
                } as ZigbeeNWKHeader,
            );

            expect(offset).toStrictEqual(3); // Command ID + new address (2 bytes) = 3 (status not read)
        });

        it("logs error when commissioning response indicates failure", () => {
            const errorSpy = vi.spyOn(logger, "error");

            nwkHandler.processCommissioningResponse(
                Buffer.from([0x78, 0x56, MACAssociationStatus.PAN_FULL]),
                0,
                {
                    frameControl: {},
                    source16: 0x5005,
                    sequenceNumber: 13,
                } as MACHeader,
                {
                    frameControl: {},
                    source16: 0x5005,
                    destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                    seqNum: 22,
                } as ZigbeeNWKHeader,
            );

            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });

        it("should send commissioning response", async () => {
            const device16 = 0x1234;
            mockContext.address16ToAddress64.set(device16, 0x00124b0012345678n);

            const result = await nwkHandler.sendCommissioningResponse(device16, 0x5678, 0x00);

            expect(result).toStrictEqual(true);
            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should send periodic link status", async () => {
            const device1Addr64 = 0x00124b0012345678n;
            const device2Addr64 = 0x00124b0087654321n;

            mockContext.deviceTable.set(device1Addr64, {
                address16: 0x1234,
                capabilities: { rxOnWhenIdle: true, deviceType: 1, alternatePANCoordinator: false } as MACCapabilities,
                authorized: true,
                neighbor: true,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [200],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });

            mockContext.deviceTable.set(device2Addr64, {
                address16: 0x5678,
                capabilities: { rxOnWhenIdle: true, deviceType: 1, alternatePANCoordinator: false } as MACCapabilities,
                authorized: true,
                neighbor: true,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [180],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });

            mockContext.address16ToAddress64.set(0x1234, device1Addr64);
            mockContext.address16ToAddress64.set(0x5678, device2Addr64);

            await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();

            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("zeroes link costs after router age limit misses", async () => {
            const deviceAddr64 = 0x00124b0012345612n;
            mockContext.deviceTable.set(deviceAddr64, {
                address16: 0x1357,
                capabilities: { rxOnWhenIdle: true, deviceType: 1, alternatePANCoordinator: false } as MACCapabilities,
                authorized: true,
                neighbor: true,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });
            mockContext.address16ToAddress64.set(0x1357, deviceAddr64);

            const findBestSourceRouteSpy = vi.spyOn(nwkHandler, "findBestSourceRoute").mockReturnValue([undefined, undefined, 2]);
            const sendLinkStatusSpy = vi.spyOn(nwkHandler, "sendLinkStatus").mockResolvedValue(undefined);

            await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();
            await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();
            await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();
            await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();

            expect(findBestSourceRouteSpy).toHaveBeenCalledTimes(3);
            expect(sendLinkStatusSpy).toHaveBeenCalledTimes(4);
            expect(sendLinkStatusSpy).toHaveBeenNthCalledWith(1, [{ address: 0x1357, incomingCost: 2, outgoingCost: 2 }]);
            expect(sendLinkStatusSpy).toHaveBeenNthCalledWith(2, [{ address: 0x1357, incomingCost: 2, outgoingCost: 2 }]);
            expect(sendLinkStatusSpy).toHaveBeenNthCalledWith(3, [{ address: 0x1357, incomingCost: 2, outgoingCost: 2 }]);
            expect(sendLinkStatusSpy).toHaveBeenNthCalledWith(4, [{ address: 0x1357, incomingCost: 0, outgoingCost: 0 }]);
        });

        it("stops treating an aged-out router as a neighbor and drops the routes it is next hop for", async () => {
            const router64 = 0x00124b0012345613n;
            const router16 = 0x1357;
            const other16 = 0x7777;
            mockContext.deviceTable.set(router64, {
                address16: router16,
                capabilities: { rxOnWhenIdle: true, deviceType: 1, alternatePANCoordinator: false } as MACCapabilities,
                authorized: true,
                neighbor: true,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });
            mockContext.address16ToAddress64.set(router16, router64);

            const direct = nwkHandler.createSourceRouteEntry([], 1);
            const viaOther = nwkHandler.createSourceRouteEntry([other16], 2);
            const firstHopRouter = nwkHandler.createSourceRouteEntry([router16], 2);
            const deeperRouter = nwkHandler.createSourceRouteEntry([router16, other16], 3);
            const firstHopRouterFar = nwkHandler.createSourceRouteEntry([other16, router16], 3);
            mockContext.sourceRouteTable.set(router16, [direct, viaOther]);
            mockContext.sourceRouteTable.set(0x2468, [firstHopRouter]);
            mockContext.sourceRouteTable.set(0x3579, [deeperRouter, firstHopRouterFar]);

            vi.spyOn(nwkHandler, "findBestSourceRoute").mockReturnValue([undefined, undefined, 1]);
            const sendLinkStatusSpy = vi.spyOn(nwkHandler, "sendLinkStatus").mockResolvedValue(undefined);

            for (let i = 0; i < 3; i++) {
                await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();
            }

            expect(mockContext.deviceTable.get(router64)!.neighbor).toStrictEqual(true);
            expect(mockContext.sourceRouteTable.get(router16)).toStrictEqual([direct, viaOther]);

            await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();

            expect(sendLinkStatusSpy).toHaveBeenNthCalledWith(4, [{ address: router16, incomingCost: 0, outgoingCost: 0 }]);
            expect(mockContext.deviceTable.get(router64)!.neighbor).toStrictEqual(false);
            // next hop is the router: its direct route, and routes whose first relay it is
            expect(mockContext.sourceRouteTable.get(router16)).toStrictEqual([viaOther]);
            expect(mockContext.sourceRouteTable.has(0x2468)).toStrictEqual(false);
            // a route that only passes through the router further along keeps its own next hop
            expect(mockContext.sourceRouteTable.get(0x3579)).toStrictEqual([deeperRouter]);

            // no longer a neighbor, so no longer advertised
            await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();

            expect(sendLinkStatusSpy).toHaveBeenNthCalledWith(5, []);
        });

        it("does not age out an end device neighbor", async () => {
            const child64 = 0x00124b0012345614n;
            const child16 = 0x1358;
            mockContext.deviceTable.set(child64, {
                address16: child16,
                capabilities: { rxOnWhenIdle: false, deviceType: 0, alternatePANCoordinator: false } as MACCapabilities,
                authorized: true,
                neighbor: true,
                lastTransportedNetworkKeySeq: undefined,
                recentLQAs: [],
                incomingNWKFrameCounter: undefined,
                endDeviceTimeout: undefined,
                linkStatusMisses: 0,
            });
            mockContext.address16ToAddress64.set(child16, child64);
            const direct = nwkHandler.createSourceRouteEntry([], 1);
            mockContext.sourceRouteTable.set(child16, [direct]);

            vi.spyOn(nwkHandler, "findBestSourceRoute").mockReturnValue([undefined, undefined, 1]);
            vi.spyOn(nwkHandler, "sendLinkStatus").mockResolvedValue(undefined);

            for (let i = 0; i < 6; i++) {
                await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();
            }

            expect(mockContext.deviceTable.get(child64)!.neighbor).toStrictEqual(true);
            expect(mockContext.sourceRouteTable.get(child16)).toStrictEqual([direct]);
        });

        it("should send periodic many-to-one route request", async () => {
            await nwkHandler.sendPeriodicManyToOneRouteRequest();

            expect(mockMACHandler.sendFrame).toHaveBeenCalled();
        });

        it("should detect duplicate source route entries", () => {
            const device16 = 0x1234;

            const entry1 = {
                relayAddresses: [0x0001, 0x0002],
                pathCost: 3,
                lastUpdated: Date.now(),
                failureCount: 0,
                lastUsed: undefined,
            };

            const entry2 = {
                relayAddresses: [0x0001, 0x0002],
                pathCost: 3,
                lastUpdated: Date.now(),
                failureCount: 0,
                lastUsed: undefined,
            };

            const isDuplicate = nwkHandler.hasSourceRoute(device16, entry2, [entry1]);
            expect(isDuplicate).toStrictEqual(true);
        });
    });

    it("dispatches rejoin response via processCommand", () => {
        const device16 = 0x4321;
        const payload = Buffer.from([ZigbeeNWKCommandId.REJOIN_RESP, device16 & 0xff, (device16 >> 8) & 0xff, MACAssociationStatus.SUCCESS]);

        const macHeader = {
            frameControl: {},
            source16: device16,
            sequenceNumber: 7,
        } as MACHeader;
        const nwkHeader = {
            frameControl: {},
            source16: device16,
            destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
            seqNum: 4,
        } as ZigbeeNWKHeader;

        const debugSpy = vi.spyOn(logger, "debug");

        nwkHandler.processCommand(payload, macHeader, nwkHeader);

        expect(debugSpy.mock.calls.some(([, ns]) => ns === "nwk-handler")).toStrictEqual(true);
        debugSpy.mockRestore();
    });

    it("routes ED timeout response through processCommand", () => {
        const spy = vi.spyOn(nwkHandler, "processEdTimeoutResponse");
        const payload = Buffer.from([ZigbeeNWKCommandId.ED_TIMEOUT_RESPONSE, 0x00, 0x07]);

        nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x1001,
                sequenceNumber: 1,
            } as MACHeader,
            {
                frameControl: {},
                source16: 0x1001,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 11,
            } as ZigbeeNWKHeader,
        );

        expect(spy).toHaveBeenCalledOnce();
        spy.mockRestore();
    });

    it("routes link power delta through processCommand", () => {
        const spy = vi.spyOn(nwkHandler, "processLinkPwrDelta");
        const payload = Buffer.from([ZigbeeNWKCommandId.LINK_PWR_DELTA, 0x02, 0x00]);

        nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x2002,
                sequenceNumber: 3,
            } as MACHeader,
            {
                frameControl: {},
                source16: 0x2002,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 5,
            } as ZigbeeNWKHeader,
        );

        expect(spy).toHaveBeenCalledOnce();
        spy.mockRestore();
    });

    it("routes commissioning response through processCommand", () => {
        const spy = vi.spyOn(nwkHandler, "processCommissioningResponse");
        const payload = Buffer.from([ZigbeeNWKCommandId.COMMISSIONING_RESPONSE, 0x78, 0x56, 0x00]);

        nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x3003,
                sequenceNumber: 9,
            } as MACHeader,
            {
                frameControl: {},
                source16: 0x3003,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 6,
            } as ZigbeeNWKHeader,
        );

        expect(spy).toHaveBeenCalledOnce();
        spy.mockRestore();
    });

    it("logs unsupported NWK command", () => {
        const errorSpy = vi.spyOn(logger, "error");

        nwkHandler.processCommand(
            Buffer.from([0xff]),
            {
                frameControl: {},
                source16: 0x4444,
                sequenceNumber: 12,
            } as MACHeader,
            {
                frameControl: {},
                source16: 0x4444,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 15,
            } as ZigbeeNWKHeader,
        );

        expect(errorSpy.mock.calls.some((call) => typeof call[0] === "string" && call[0].includes("Unsupported"))).toStrictEqual(true);
        errorSpy.mockRestore();
    });

    it("decodes route request with extended destination", async () => {
        const sendRouteReplySpy = vi.spyOn(nwkHandler, "sendRouteReply").mockResolvedValue(true);
        const destination64 = 0x00124b0000000001n;
        const payload = Buffer.alloc(1 + 1 + 1 + 2 + 1 + 8);
        let offset = 0;
        offset = payload.writeUInt8(ZigbeeNWKCommandId.ROUTE_REQ, offset);
        offset = payload.writeUInt8(ZigbeeNWKConsts.CMD_ROUTE_OPTION_DEST_EXT, offset);
        offset = payload.writeUInt8(0x55, offset);
        offset = payload.writeUInt16LE(0x3456, offset);
        offset = payload.writeUInt8(0x00, offset);
        payload.writeBigUInt64LE(destination64, offset);

        await nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                source16: 0x2100,
                sequenceNumber: 18,
            } as MACHeader,
            {
                frameControl: {},
                source16: 0x2100,
                source64: 0x00124b0011223344n,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                radius: 2,
                seqNum: 19,
            } as ZigbeeNWKHeader,
        );

        expect(sendRouteReplySpy).toHaveBeenCalledOnce();
        expect(sendRouteReplySpy.mock.calls[0][6]).toStrictEqual(destination64);
        sendRouteReplySpy.mockRestore();
    });

    it("unicasts the route reply back to the neighbour that broadcast the request", async () => {
        const sendRouteReplySpy = vi.spyOn(nwkHandler, "sendRouteReply").mockResolvedValue(true);
        const firstHop16 = 0x8e8d;
        const payload = Buffer.alloc(1 + 1 + 1 + 2 + 1);
        let offset = 0;
        offset = payload.writeUInt8(ZigbeeNWKCommandId.ROUTE_REQ, offset);
        offset = payload.writeUInt8(0, offset);
        offset = payload.writeUInt8(0x99, offset);
        offset = payload.writeUInt16LE(ZigbeeConsts.COORDINATOR_ADDRESS, offset);
        payload.writeUInt8(0x00, offset);

        await nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                // a route request is broadcast, so this is never the originator's address
                destination16: ZigbeeMACConsts.BCAST_ADDR,
                source16: firstHop16,
                sequenceNumber: 42,
            } as MACHeader,
            {
                frameControl: {},
                source16: firstHop16,
                source64: 0x00124b0011223344n,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                radius: 30,
                seqNum: 43,
            } as ZigbeeNWKHeader,
        );

        expect(sendRouteReplySpy).toHaveBeenCalledOnce();
        expect(sendRouteReplySpy.mock.calls[0][0]).toStrictEqual(firstHop16);
        sendRouteReplySpy.mockRestore();
    });

    it("purges relay references while retaining alternate routes", async () => {
        vi.spyOn(nwkHandler, "sendPeriodicManyToOneRouteRequest").mockResolvedValue();

        const failingDest = 0x2200;
        const now = Date.now();

        mockContext.sourceRouteTable.set(failingDest, [
            {
                relayAddresses: [0x3300],
                pathCost: 1,
                lastUpdated: now,
                failureCount: 2,
                lastUsed: undefined,
            },
        ]);

        mockContext.sourceRouteTable.set(0x4400, [
            {
                relayAddresses: [failingDest],
                pathCost: 3,
                lastUpdated: now,
                failureCount: 0,
                lastUsed: undefined,
            },
            {
                relayAddresses: [0x5500],
                pathCost: 2,
                lastUpdated: now,
                failureCount: 0,
                lastUsed: undefined,
            },
        ]);

        nwkHandler.markRouteFailure(failingDest);

        await new Promise((resolve) => setImmediate(resolve));

        const filtered = mockContext.sourceRouteTable.get(0x4400);
        expect(filtered).toBeDefined();
        expect(filtered).toHaveLength(1);
        expect(filtered?.[0].relayAddresses).toEqual([0x5500]);
    });

    it("stores route record using IEEE source when short address missing", () => {
        const device64 = 0x00124b0000667788n;
        mockContext.deviceTable.set(device64, {
            address16: 0x7788,
            capabilities: undefined,
            authorized: true,
            neighbor: true,
            lastTransportedNetworkKeySeq: undefined,
            recentLQAs: [],
            incomingNWKFrameCounter: undefined,
            endDeviceTimeout: undefined,
            linkStatusMisses: 0,
        });

        const existingEntry = nwkHandler.createSourceRouteEntry([0x1001], 2);
        mockContext.sourceRouteTable.set(0x7788, [existingEntry]);

        const payload = Buffer.from([ZigbeeNWKCommandId.ROUTE_RECORD, 0x01, 0x34, 0x12]);

        nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x5555,
                sequenceNumber: 8,
            } as MACHeader,
            {
                frameControl: {},
                source16: undefined,
                source64: device64,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 13,
            } as ZigbeeNWKHeader,
        );

        const routes = mockContext.sourceRouteTable.get(0x7788);
        expect(routes).toBeDefined();
        expect(routes).toHaveLength(2);
    });

    it("refreshes the known path when a route record repeats it", async () => {
        const source16 = 0x8899;
        const staleUpdate = Date.now() - 400000;

        mockContext.sourceRouteTable.set(source16, [
            {
                relayAddresses: [0x1234],
                pathCost: 2,
                lastUpdated: staleUpdate,
                failureCount: 2,
                lastUsed: undefined,
            },
        ]);

        const payload = Buffer.from([ZigbeeNWKCommandId.ROUTE_RECORD, 0x01, 0x34, 0x12]);

        await nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x1234,
                sequenceNumber: 21,
            } as MACHeader,
            {
                frameControl: {},
                source16,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 22,
            } as ZigbeeNWKHeader,
        );

        const routes = mockContext.sourceRouteTable.get(source16);
        expect(routes).toHaveLength(1);
        expect(routes?.[0].relayAddresses).toStrictEqual([0x1234]);
        expect(routes?.[0].lastUpdated).toBeGreaterThan(staleUpdate);
        expect(routes?.[0].failureCount).toStrictEqual(0);
    });

    it("keeps a repeated path usable past the route expiry", async () => {
        const source16 = 0x9911;
        const source64 = 0x00124b0000991122n;

        mockContext.deviceTable.set(source64, {
            address16: source16,
            capabilities: undefined,
            authorized: true,
            neighbor: false,
            lastTransportedNetworkKeySeq: undefined,
            recentLQAs: [],
            incomingNWKFrameCounter: undefined,
            endDeviceTimeout: undefined,
            linkStatusMisses: 0,
        });
        mockContext.address16ToAddress64.set(source16, source64);
        // learned longer ago than CONFIG_NWK_ROUTE_EXPIRY_TIME
        mockContext.sourceRouteTable.set(source16, [
            {
                relayAddresses: [0x1234],
                pathCost: 2,
                lastUpdated: Date.now() - 400000,
                failureCount: 0,
                lastUsed: undefined,
            },
        ]);

        const payload = Buffer.from([ZigbeeNWKCommandId.ROUTE_RECORD, 0x01, 0x34, 0x12]);

        await nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x1234,
                sequenceNumber: 23,
            } as MACHeader,
            {
                frameControl: {},
                source16,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 24,
            } as ZigbeeNWKHeader,
        );

        expect(nwkHandler.findBestSourceRoute(source16, undefined)).toStrictEqual([0, [0x1234], 2]);
        expect(mockContext.sourceRouteTable.get(source16)).toHaveLength(1);
    });

    it("stores a new entry when the route record carries an unknown path", async () => {
        const source16 = 0xaa22;

        mockContext.sourceRouteTable.set(source16, [
            {
                relayAddresses: [0x1234],
                pathCost: 2,
                lastUpdated: Date.now(),
                failureCount: 0,
                lastUsed: undefined,
            },
        ]);

        const payload = Buffer.from([ZigbeeNWKCommandId.ROUTE_RECORD, 0x01, 0x78, 0x56]);

        await nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x5678,
                sequenceNumber: 25,
            } as MACHeader,
            {
                frameControl: {},
                source16,
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 26,
            } as ZigbeeNWKHeader,
        );

        const routes = mockContext.sourceRouteTable.get(source16);
        expect(routes).toHaveLength(2);
        expect(routes?.[1].relayAddresses).toStrictEqual([0x5678]);
    });

    it("creates the source route table entry for an unknown destination", () => {
        const destination16 = 0xbb33;

        nwkHandler.upsertSourceRoute(destination16, nwkHandler.createSourceRouteEntry([0x1234], 2));

        const routes = mockContext.sourceRouteTable.get(destination16);
        expect(routes).toHaveLength(1);
        expect(routes?.[0].relayAddresses).toStrictEqual([0x1234]);
    });

    it("refreshes cost, age and failure count of a known path on upsert", () => {
        const destination16 = 0xcc44;
        const staleUpdate = Date.now() - 400000;

        mockContext.sourceRouteTable.set(destination16, [
            {
                relayAddresses: [0x1234, 0x5678],
                pathCost: 5,
                lastUpdated: staleUpdate,
                failureCount: 3,
                lastUsed: staleUpdate,
            },
        ]);

        nwkHandler.upsertSourceRoute(destination16, nwkHandler.createSourceRouteEntry([0x1234, 0x5678], 3));

        const routes = mockContext.sourceRouteTable.get(destination16);
        expect(routes).toHaveLength(1);
        expect(routes?.[0].pathCost).toStrictEqual(3);
        expect(routes?.[0].lastUpdated).toBeGreaterThan(staleUpdate);
        expect(routes?.[0].failureCount).toStrictEqual(0);
        // untouched by a refresh
        expect(routes?.[0].lastUsed).toStrictEqual(staleUpdate);
    });

    it("appends an unknown path on upsert, keeping the known one", () => {
        const destination16 = 0xdd55;

        mockContext.sourceRouteTable.set(destination16, [
            {
                relayAddresses: [0x1234],
                pathCost: 2,
                lastUpdated: Date.now(),
                failureCount: 0,
                lastUsed: undefined,
            },
        ]);

        nwkHandler.upsertSourceRoute(destination16, nwkHandler.createSourceRouteEntry([0x1234, 0x5678], 3));

        const routes = mockContext.sourceRouteTable.get(destination16);
        expect(routes).toHaveLength(2);
        expect(routes?.[0].relayAddresses).toStrictEqual([0x1234]);
        expect(routes?.[1].relayAddresses).toStrictEqual([0x1234, 0x5678]);
    });

    it("refreshes the known path from a link status, without duplicating it", async () => {
        const source16 = 0xee66;
        const source64 = 0x00124b0000ee6677n;
        const staleUpdate = Date.now() - 400000;

        mockContext.deviceTable.set(source64, {
            address16: source16,
            capabilities: undefined,
            authorized: true,
            neighbor: true,
            lastTransportedNetworkKeySeq: undefined,
            recentLQAs: [],
            incomingNWKFrameCounter: undefined,
            endDeviceTimeout: undefined,
            linkStatusMisses: 0,
        });
        mockContext.address16ToAddress64.set(source16, source64);
        mockContext.sourceRouteTable.set(source16, [
            {
                relayAddresses: [],
                pathCost: 1,
                lastUpdated: staleUpdate,
                failureCount: 1,
                lastUsed: undefined,
            },
        ]);

        const payload = Buffer.alloc(1 + 1 + 2 + 1);
        let offset = 0;
        offset = payload.writeUInt8(ZigbeeNWKCommandId.LINK_STATUS, offset);
        offset = payload.writeUInt8(ZigbeeNWKConsts.CMD_LINK_OPTION_FIRST_FRAME | ZigbeeNWKConsts.CMD_LINK_OPTION_LAST_FRAME | 1, offset);
        offset = payload.writeUInt16LE(ZigbeeConsts.COORDINATOR_ADDRESS, offset);
        payload.writeUInt8(0x11, offset);

        await nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16,
                sequenceNumber: 27,
            } as MACHeader,
            {
                frameControl: {},
                source16,
                source64,
                destination16: ZigbeeConsts.BCAST_DEFAULT,
                seqNum: 28,
            } as ZigbeeNWKHeader,
        );

        const routes = mockContext.sourceRouteTable.get(source16);
        expect(routes).toHaveLength(1);
        expect(routes?.[0].lastUpdated).toBeGreaterThan(staleUpdate);
        expect(routes?.[0].failureCount).toStrictEqual(0);
    });

    it("adds a next hop entry when a route reply comes through a new router", () => {
        const responder16 = 0x6677;
        const responder64 = 0x00124b0010102020n;

        mockContext.deviceTable.set(responder64, {
            address16: responder16,
            capabilities: undefined,
            authorized: true,
            neighbor: true,
            lastTransportedNetworkKeySeq: undefined,
            recentLQAs: [],
            incomingNWKFrameCounter: undefined,
            endDeviceTimeout: undefined,
            linkStatusMisses: 0,
        });
        mockContext.address16ToAddress64.set(responder16, responder64);

        const existing = nwkHandler.createSourceRouteEntry([0x1111], 2);
        mockContext.sourceRouteTable.set(responder16, [existing]);

        const payload = Buffer.alloc(1 + 1 + 1 + 2 + 2 + 1 + 8 + 8);
        let offset = 0;
        offset = payload.writeUInt8(ZigbeeNWKCommandId.ROUTE_REPLY, offset);
        offset = payload.writeUInt8(ZigbeeNWKConsts.CMD_ROUTE_OPTION_ORIG_EXT | ZigbeeNWKConsts.CMD_ROUTE_OPTION_RESP_EXT, offset);
        offset = payload.writeUInt8(0x42, offset);
        offset = payload.writeUInt16LE(ZigbeeConsts.COORDINATOR_ADDRESS, offset);
        offset = payload.writeUInt16LE(responder16, offset);
        offset = payload.writeUInt8(0x00, offset);
        offset = payload.writeBigUInt64LE(mockContext.netParams.eui64, offset);
        payload.writeBigUInt64LE(responder64, offset);

        nwkHandler.processCommand(
            payload,
            {
                frameControl: {},
                source16: 0x2222,
                sequenceNumber: 14,
            } as MACHeader,
            {
                frameControl: {},
                source16: 0x1234,
                relayAddresses: [0x9999],
                destination16: ZigbeeConsts.COORDINATOR_ADDRESS,
                seqNum: 16,
            } as ZigbeeNWKHeader,
        );

        const routes = mockContext.sourceRouteTable.get(responder16);
        expect(routes).toBeDefined();
        expect(routes).toHaveLength(2);
        // only the next hop: the reply carries no path to the responder
        expect(routes?.[1].relayAddresses).toEqual([0x2222]);
        expect(routes?.[1].nextHopOnly).toStrictEqual(true);
    });

    it("skips neighbors without short address mapping in periodic link status", async () => {
        const device64 = 0x00124b00aa55eeffn;
        mockContext.deviceTable.set(device64, {
            address16: 0x8899,
            capabilities: undefined,
            authorized: true,
            neighbor: true,
            lastTransportedNetworkKeySeq: undefined,
            recentLQAs: [],
            incomingNWKFrameCounter: undefined,
            endDeviceTimeout: undefined,
            linkStatusMisses: 0,
        });

        const linkSpy = vi.spyOn(nwkHandler, "sendLinkStatus").mockResolvedValue();

        await nwkHandler.sendPeriodicZigbeeNWKLinkStatus();

        expect(linkSpy).toHaveBeenCalledWith([]);
        linkSpy.mockRestore();
    });
});
