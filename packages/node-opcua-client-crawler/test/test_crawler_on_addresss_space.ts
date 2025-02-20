import { should } from "should";
import * as sinon from "sinon";

import {
    AddressSpace,
    getMiniAddressSpace,
    PseudoSession,
    UAVariable,
} from "node-opcua-address-space";

import {
    ObjectIds
} from "node-opcua-constants";
import { BrowseDirection } from "node-opcua-data-model";
import {
    makeNodeId,
    NodeId
} from "node-opcua-nodeid";

import {
    CacheNode,
    NodeCrawler,
    UserData
} from "..";
import { DataType } from "node-opcua-client";

describe("NodeCrawler", () => {

    let addressSpace: AddressSpace;
    let groupNodeId: NodeId;
    before(async () => {

        addressSpace = await getMiniAddressSpace();

        const group = addressSpace.getOwnNamespace().addObject({
            browseName: "Group",
            organizedBy: addressSpace.rootFolder.objects
        });

        for (let i = 0; i < 10; i++) {
            addressSpace.getOwnNamespace().addObject({
                browseName: "Object" + i,
                organizedBy: group
            });
        }
        groupNodeId = group.nodeId;
    });
    after(() => {
        if (addressSpace) {
            addressSpace.dispose();
        }
    });

    function followForward(crawler: NodeCrawler, cacheNode: CacheNode, userData: UserData) {

        NodeCrawler.follow(crawler, cacheNode, userData, "Organizes", BrowseDirection.Forward);
        NodeCrawler.follow(crawler, cacheNode, userData, "HasComponent", BrowseDirection.Forward);
        NodeCrawler.follow(crawler, cacheNode, userData, "HasProperty", BrowseDirection.Forward);

        // for (const reference  of cacheNode.references) {
        //    if (reference.isForward && reference.referenceTypeId.toString() === "i=35") {
        //        console.log( cacheNode.browseName, reference.isForward, reference.nodeId.toString());
        //        crawler.followReference(cacheNode, reference, userData);
        //    }
        // }
    }

    it("should crawl on a PseudoSession", async () => {

        const session = new PseudoSession(addressSpace);

        const crawler = new NodeCrawler(session);

        const results: string[] = [];

        const data = {
            onBrowse(this: UserData, crawler1: NodeCrawler, cacheNode: CacheNode) {
                results.push(cacheNode.browseName.toString());
                followForward(crawler1, cacheNode, this);
            }
        };
        const nodeId = makeNodeId(ObjectIds.Server_ServerCapabilities); // server

        await crawler.crawl(nodeId, data);

        results.sort().join(" ").should.eql(
          "HasComponent HasProperty " +
          "LocaleIdArray " +
          "MaxMonitoredItemsPerCall "+
          "MaxNodesPerBrowse " +
          "MaxNodesPerHistoryReadData " +
          "MaxNodesPerHistoryReadEvents " +
          "MaxNodesPerHistoryUpdateData " +
          "MaxNodesPerHistoryUpdateEvents " +
          "MaxNodesPerMethodCall " +
          "MaxNodesPerNodeManagement " +
          "MaxNodesPerRead " +
          "MaxNodesPerRegisterNodes " +
          "MaxNodesPerTranslateBrowsePathsToNodeIds " +
          "MaxNodesPerWrite " + 
          "OperationLimits " +
          "ServerCapabilities");

    });

    it("should crawl a very large number of nodes", async () => {

        const session = new PseudoSession(addressSpace);

        (session as any).browse = sinon.spy(session, "browse");
        (session as any).browseNext = sinon.spy(session, "browseNext");
        (session as any).read = sinon.spy(session, "read");

        const crawler = new NodeCrawler(session);
        crawler.maxNodesPerBrowse = 5;

        const results: string[] = [];

        const data = {
            onBrowse(this: UserData, crawler1: NodeCrawler, cacheNode: CacheNode) {
                results.push(cacheNode.browseName.toString());
                followForward(crawler1, cacheNode, this);
                // NodeCrawler.follow(crawler1, cacheNode, this, "Organizes");
            }
        };

        await crawler.crawl(groupNodeId, data);

        results.sort().join(" ").should.eql(
          "1:Group 1:Object0 1:Object1 " +
          "1:Object2 1:Object3 1:Object4 " +
          "1:Object5 1:Object6 1:Object7 " +
          "1:Object8 1:Object9 Organizes");

        console.log("browseCounter = ",     crawler.browseCounter);
        console.log("browseNextCounter = ", crawler.browseNextCounter);
        console.log("readCounter = ",       crawler.readCounter);
        // crawler.browseNextCounter.should.be.greaterThan(0);
    });

    it("issue #655: it should used provided MaxNodePerRead/MaxNodePerBrowse as a minimum value when set <> 0 and server provide limits", async () => {

        // Given a server that provides some limit for MaxNodesPerRead && MaxNodesPerBrowse
        const maxNodesPerReadVar = addressSpace.findNode("Server_ServerCapabilities_OperationLimits_MaxNodesPerRead")! as UAVariable;
        const maxNodesPerBrowseVar = addressSpace.findNode("Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse")! as UAVariable;

        maxNodesPerReadVar.setValueFromSource({ dataType: DataType.UInt32, value: 251});
        maxNodesPerBrowseVar.setValueFromSource({ dataType: DataType.UInt32, value: 252});
       
        maxNodesPerReadVar.readValue().value.value.should.eql(251);
        maxNodesPerBrowseVar.readValue().value.value.should.eql(252);
        
        const session = new PseudoSession(addressSpace);

        {
            // Given that NodeCrawler doesn't specify minimum value for  maxNodesPerRead/Browse
            const crawler = new NodeCrawler(session);
            crawler.maxNodesPerRead = 0;
            crawler.maxNodesPerBrowse = 0;
            await crawler.crawl(groupNodeId,{ onBrowse: () => {/* empty */} });

            // then NodeCrawler shall be set with value provided by server
            crawler.maxNodesPerRead.should.eql(251);
            crawler.maxNodesPerBrowse.should.eql(252);
        }

        {
            // Given that NodeCrawler does  specify minimum value for  maxNodesPerRead/Browse
            // which are below server provided limit
            const crawler = new NodeCrawler(session);
            crawler.maxNodesPerRead = 5;
            crawler.maxNodesPerBrowse = 10;
            await crawler.crawl(groupNodeId,{ onBrowse: () => {/* empty */} });
            // then NodeCrawler shall be set with value provided by itself
            crawler.maxNodesPerRead.should.eql(5);
            crawler.maxNodesPerBrowse.should.eql(10);
        }
        {
            // Given that NodeCrawler does  specify minimum value for  maxNodesPerRead/Browse
            // which are above server provided limit
            const crawler = new NodeCrawler(session);
            crawler.maxNodesPerRead = 501;
            crawler.maxNodesPerBrowse = 502;
            await crawler.crawl(groupNodeId,{ onBrowse: () => {/* empty */} });
            // then NodeCrawler shall be set with value provided by server
            crawler.maxNodesPerRead.should.eql(251);
            crawler.maxNodesPerBrowse.should.eql(252);
        }

    });
    it("issue #655: it should used provided MaxNodePerRead/MaxNodePerBrowse as a minimum value when set <> 0 and server do not provide limits", async () => {

        // Given a server that DOES NOT provide some limit for MaxNodesPerRead && MaxNodesPerBrowse
        const maxNodesPerReadVar = addressSpace.findNode("Server_ServerCapabilities_OperationLimits_MaxNodesPerRead")! as UAVariable;
        const maxNodesPerBrowseVar = addressSpace.findNode("Server_ServerCapabilities_OperationLimits_MaxNodesPerBrowse")! as UAVariable;

        maxNodesPerReadVar.setValueFromSource({ dataType: DataType.UInt32, value: 0});
        maxNodesPerBrowseVar.setValueFromSource({ dataType: DataType.UInt32, value: 0});

        maxNodesPerReadVar.readValue().value.value.should.eql(0);
        maxNodesPerBrowseVar.readValue().value.value.should.eql(0);

        const session = new PseudoSession(addressSpace);

        {
            // Given that NodeCrawler doesn't specify minimum value for  maxNodesPerRead/Browse
            const crawler = new NodeCrawler(session);
            crawler.maxNodesPerRead = 0;
            crawler.maxNodesPerBrowse = 0;
            // then NodeCrawler shall be set with default value provided by NodeCrawler
            await crawler.crawl(groupNodeId,{ onBrowse: () => {/* empty */} });
            crawler.maxNodesPerRead.should.eql(100);
            crawler.maxNodesPerBrowse.should.eql(100);
        }

        {
            const crawler = new NodeCrawler(session);
            // Given that NodeCrawler doesn't specify minimum value for  maxNodesPerRead/Browse
            crawler.maxNodesPerRead = 5;
            crawler.maxNodesPerBrowse = 10;
            await crawler.crawl(groupNodeId,{ onBrowse: () => {/* empty */} });
            // then NodeCrawler shall be set with value provided by itself
            crawler.maxNodesPerRead.should.eql(5);
            crawler.maxNodesPerBrowse.should.eql(10);
        }
        {
            const crawler = new NodeCrawler(session);
            // Given that NodeCrawler doesn't specify minimum value for  maxNodesPerRead/Browse
            // and greater than default value
            crawler.maxNodesPerRead = 501;
            crawler.maxNodesPerBrowse = 502;
            await crawler.crawl(groupNodeId,{ onBrowse: () => {/* empty */} });
            // then NodeCrawler shall be set with value provided by itself
            crawler.maxNodesPerRead.should.eql(501);
            crawler.maxNodesPerBrowse.should.eql(502);
        }

    });
});
