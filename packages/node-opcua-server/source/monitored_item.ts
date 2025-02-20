/**
 * @module node-opcua-server
 */
// tslint:disable:no-console
import chalk from "chalk";
import { EventEmitter } from "events";
import { assert } from "node-opcua-assert";
import * as _ from "underscore";

import { BaseNode, EventData, makeAttributeEventName, SessionContext, UAVariable } from "node-opcua-address-space";
import { DateTime } from "node-opcua-basic-types";
import { NodeClass, QualifiedNameOptions } from "node-opcua-data-model";
import { AttributeIds } from "node-opcua-data-model";
import { apply_timestamps, DataValue, extractRange, sameDataValue } from "node-opcua-data-value";
import {
    checkDebugFlag, make_debugLog
} from "node-opcua-debug";
import { ExtensionObject } from "node-opcua-extension-object";
import { NodeId } from "node-opcua-nodeid";
import { NumericalRange0, NumericRange } from "node-opcua-numeric-range";
import { ObjectRegistry } from "node-opcua-object-registry";
import { extractEventFields } from "node-opcua-service-filter";
import { EventFilter } from "node-opcua-service-filter";
import {
    ReadValueId,
    TimestampsToReturn
} from "node-opcua-service-read";
import {
    MonitoredItemModifyResult, MonitoredItemNotification, MonitoringMode,
    MonitoringParameters
} from "node-opcua-service-subscription";
import {
    checkDeadBand, DataChangeFilter, DataChangeTrigger, DeadbandType
} from "node-opcua-service-subscription";
import { StatusCode, StatusCodes } from "node-opcua-status-code";
import {EventFieldList, MonitoringFilter, ReadValueIdOptions, SimpleAttributeOperand} from "node-opcua-types";
import { sameVariant, Variant } from "node-opcua-variant";

import { appendToTimer, removeFromTimer } from "./node_sampler";
import { validateFilter } from "./validate_filter";

const defaultItemToMonitor: ReadValueIdOptions = new ReadValueId({
    attributeId: AttributeIds.Value,
    indexRange: undefined,
});

const debugLog = make_debugLog(__filename);
const doDebug = checkDebugFlag(__filename);

function _adjust_sampling_interval(samplingInterval: number, node_minimumSamplingInterval: number): number {

    assert(_.isNumber(node_minimumSamplingInterval), "expecting a number");

    if (samplingInterval === 0) {
        return (node_minimumSamplingInterval === 0)
          ? samplingInterval
          : Math.max(MonitoredItem.minimumSamplingInterval, node_minimumSamplingInterval);
    }
    assert(samplingInterval >= 0, " this case should have been prevented outside");
    samplingInterval = samplingInterval || MonitoredItem.defaultSamplingInterval;
    samplingInterval = Math.max(samplingInterval, MonitoredItem.minimumSamplingInterval);
    samplingInterval = Math.min(samplingInterval, MonitoredItem.maximumSamplingInterval);
    samplingInterval = node_minimumSamplingInterval === 0
      ? samplingInterval
      : Math.max(samplingInterval, node_minimumSamplingInterval);

    return samplingInterval;
}

const maxQueueSize = 5000;

function _adjust_queue_size(queueSize: number): number {
    queueSize = Math.min(queueSize, maxQueueSize);
    queueSize = Math.max(1, queueSize);
    return queueSize;
}

function _validate_parameters(monitoringParameters: any) {
    // xx assert(options instanceof MonitoringParameters);
    assert(monitoringParameters.hasOwnProperty("clientHandle"));
    assert(monitoringParameters.hasOwnProperty("samplingInterval"));
    assert(_.isFinite(monitoringParameters.clientHandle));
    assert(_.isFinite(monitoringParameters.samplingInterval));
    assert(_.isBoolean(monitoringParameters.discardOldest));
    assert(_.isFinite(monitoringParameters.queueSize));
    assert(monitoringParameters.queueSize >= 0);
}

function statusCodeHasChanged(
  newDataValue: DataValue,
  oldDataValue: DataValue
): boolean {
    assert(newDataValue instanceof DataValue);
    assert(oldDataValue instanceof DataValue);
    return newDataValue.statusCode !== oldDataValue.statusCode;
}

function valueHasChanged(
  this: MonitoredItem,
  newDataValue: DataValue,
  oldDataValue: DataValue,
  deadbandType: DeadbandType,
  deadbandValue: number
): boolean {

    assert(newDataValue instanceof DataValue);
    assert(oldDataValue instanceof DataValue);
    switch (deadbandType) {
        case DeadbandType.None:
            assert(newDataValue.value instanceof Variant);
            assert(newDataValue.value instanceof Variant);
            // No Deadband calculation should be applied.
            return checkDeadBand(oldDataValue.value, newDataValue.value, DeadbandType.None);
        case DeadbandType.Absolute:
            // AbsoluteDeadband
            return checkDeadBand(oldDataValue.value, newDataValue.value, DeadbandType.Absolute, deadbandValue);
        default:
            // Percent_2    PercentDeadband (This type is specified in Part 8).
            assert(deadbandType === DeadbandType.Percent);

            // The range of the deadbandValue is from 0.0 to 100.0 Percent.
            assert(deadbandValue >= 0 && deadbandValue <= 100);

            // DeadbandType = PercentDeadband
            // For this type of deadband the deadbandValue is defined as the percentage of the EURange. That is,
            // it applies only to AnalogItems with an EURange Property that defines the typical value range for the
            // item. This range shall be multiplied with the deadbandValue and then compared to the actual value change
            // to determine the need for a data change notification. The following pseudo code shows how the deadband
            // is calculated:
            //      DataChange if (absolute value of (last cached value - current value) >
            //                                          (deadbandValue/100.0) * ((high-low) of EURange)))
            //
            // Specifying a deadbandValue outside of this range will be rejected and reported with the
            // StatusCode BadDeadbandFilterInvalid (see Table 27).
            // If the Value of the MonitoredItem is an array, then the deadband calculation logic shall be applied to
            // each element of the array. If an element that requires a DataChange is found, then no further
            // deadband checking is necessary and the entire array shall be returned.
            assert(this.node !== null, "expecting a valid address_space object here to get access the the EURange");

            if ((this.node! as any).euRange) {
                // double,double
                const rangeVariant = (this.node! as any).euRange.readValue().value;
                const range = rangeVariant.value.high - rangeVariant.value.high;
                assert(_.isFinite(range));
                return checkDeadBand(
                  oldDataValue.value,
                  newDataValue.value,
                  DeadbandType.Percent, deadbandValue, range);

            }
            return true;
    }
}

function timestampHasChanged(t1: DateTime, t2: DateTime): boolean {
    if ((t1 || !t2) || (t2 || !t1)) {
        return true;
    }
    if (!t1 || !t2) {
        return false;
    }
    return (t1 as Date).getTime() !== (t2 as Date).getTime();
}

function isGoodish(statusCode: StatusCode): boolean {
    return statusCode.value < 0x10000000;
}

function apply_datachange_filter(
  this: MonitoredItem,
  newDataValue: DataValue, oldDataValue: DataValue
): boolean {

    if (!this.filter || !(this.filter instanceof DataChangeFilter)) {
        throw new Error("Internal Error");
    }
    assert(this.filter instanceof DataChangeFilter);
    assert(newDataValue instanceof DataValue);
    assert(oldDataValue instanceof DataValue);

    const trigger = this.filter.trigger;

    switch (trigger) {
        case DataChangeTrigger.Status: // Status
            //              Report a notification ONLY if the StatusCode associated with
            //              the value changes. See Table 166 for StatusCodes defined in
            //              this standard. Part 8 specifies additional StatusCodes that are
            //              valid in particular for device data.
            return statusCodeHasChanged(newDataValue, oldDataValue);

        case DataChangeTrigger.StatusValue: // StatusValue
            //              Report a notification if either the StatusCode or the value
            //              change. The Deadband filter can be used in addition for
            //              filtering value changes.
            //              This is the default setting if no filter is set.
            return statusCodeHasChanged(newDataValue, oldDataValue) ||
              valueHasChanged.call(this, newDataValue, oldDataValue,
                this.filter.deadbandType, this.filter.deadbandValue);

        default: // StatusValueTimestamp
            //              Report a notification if either StatusCode, value or the
            //              SourceTimestamp change.
            //
            //              If a Deadband filter is specified,this trigger has the same behaviour as STATUS_VALUE_1.
            //
            //              If the DataChangeFilter is not applied to the monitored item, STATUS_VALUE_1
            //              is the default reporting behaviour
            assert(trigger === DataChangeTrigger.StatusValueTimestamp);
            return timestampHasChanged(newDataValue.sourceTimestamp, oldDataValue.sourceTimestamp) ||
              statusCodeHasChanged(newDataValue, oldDataValue) ||
              valueHasChanged.call(this, newDataValue, oldDataValue,
                this.filter.deadbandType, this.filter.deadbandValue);
    }
    return false;
}

function apply_filter(
  this: MonitoredItem,
  newDataValue: DataValue
) {

    if (!this.oldDataValue) {
        return true; // keep
    }
    if (this.filter instanceof DataChangeFilter) {
        return apply_datachange_filter.call(this, newDataValue, this.oldDataValue);
    }
    return true; // keep
    // else {
    //      // if filter not set, by default report changes to Status or Value only
    //      return !sameDataValue(newDataValue, this.oldDataValue, TimestampsToReturn.Neither);
    // }
    // return true; // keep
}

function setSemanticChangeBit(notification: any) {
    if (notification && notification.hasOwnProperty("value")) {
        notification.value.statusCode =
          StatusCodes.makeStatusCode(notification.value.statusCode, "SemanticChanged");
    }
}

const useCommonTimer = true;

export interface MonitoredItemOptions extends MonitoringParameters {

    monitoringMode: MonitoringMode;
    /**
     * the monitoredItem Id assigned by the server to this monitoredItem.
     */
    monitoredItemId: number;
    itemToMonitor?: ReadValueIdOptions;
    timestampsToReturn?: TimestampsToReturn;

    // MonitoringParameters
    filter: (ExtensionObject | null);
    /**
     * if discardOldest === true, older items are removed from the queue when queue overflows
     */
    discardOldest: boolean;
    /**
     * the size of the queue.
     */
    queueSize: number;
    /**
     * the monitored item sampling interval ..
     */
    samplingInterval: number;
    /**
     * the client handle
     */
    clientHandle: number;
}

export interface BaseNode2 extends EventEmitter {
    nodeId: NodeId;
    browseName: QualifiedNameOptions;
    nodeClass: NodeClass;
    dataType: NodeId;
    addressSpace: any;

    readAttribute(context: SessionContext | null, attributeId: AttributeIds): DataValue;
}

export type QueueItem = MonitoredItemNotification | EventFieldList;

type TimerKey = NodeJS.Timer;

/**
 * a server side monitored item
 *
 * - Once created, the MonitoredItem will raised an "samplingEvent" event every "samplingInterval" millisecond
 *   until {{#crossLink "MonitoredItem/terminate:method"}}{{/crossLink}} is called.
 *
 * - It is up to the  event receiver to call {{#crossLink "MonitoredItem/recordValue:method"}}{{/crossLink}}.
 *
 */
export class MonitoredItem extends EventEmitter {

    public get node(): BaseNode | null {
        return this._node;
    }

    public set node(someNode: BaseNode | null) {
        throw new Error("Unexpected way to set node");
    }

    public static registry = new ObjectRegistry();
    public static minimumSamplingInterval = 50;              // 50 ms as a minimum sampling interval
    public static defaultSamplingInterval = 1500;            // 1500 ms as a default sampling interval
    public static maximumSamplingInterval = 1000 * 60 * 60;  // 1 hour !

    public samplingInterval: number = -1;
    public monitoredItemId: number;
    public overflow: boolean;
    public oldDataValue?: DataValue;
    public monitoringMode: MonitoringMode;
    public timestampsToReturn: TimestampsToReturn;
    public itemToMonitor: any;
    public filter: MonitoringFilter | null;
    public discardOldest: boolean = true;
    public queueSize: number = 0;
    public clientHandle?: number;
    public $subscription: any;
    public _samplingId?: TimerKey | string;
    public samplingFunc: ((
      this: MonitoredItem,
      value: DataValue,
      callback: (err: Error | null, dataValue?: DataValue) => void
    ) => void) | null = null;

    private _node: BaseNode | null;
    private queue: QueueItem[];
    private _semantic_version: number;
    private _is_sampling: boolean = false;
    private _on_opcua_event_received_callback: any;
    private _attribute_changed_callback: any;
    private _value_changed_callback: any;
    private _semantic_changed_callback: any;
    private _on_node_disposed_listener: any;

    constructor(options: MonitoredItemOptions) {

        super();

        assert(options.hasOwnProperty("monitoredItemId"));
        assert(!options.monitoringMode, "use setMonitoring mode explicitly to activate the monitored item");

        options.itemToMonitor = options.itemToMonitor || defaultItemToMonitor;

        this._samplingId = undefined;

        this._set_parameters(options);

        this.monitoredItemId = options.monitoredItemId; // ( known as serverHandle)

        this.queue = [];
        this.overflow = false;

        this.oldDataValue = new DataValue({ statusCode: StatusCodes.BadDataUnavailable }); // unset initially

        // user has to call setMonitoringMode
        this.monitoringMode = MonitoringMode.Invalid;

        this.timestampsToReturn = options.timestampsToReturn || TimestampsToReturn.Neither;

        this.itemToMonitor = options.itemToMonitor;

        this.filter = options.filter as MonitoringFilter || null;

        this._node = null;
        this._semantic_version = 0;

        if (doDebug) {
            debugLog("Monitoring ", options.itemToMonitor.toString());
        }

        this._on_node_disposed_listener = null;

        MonitoredItem.registry.register(this);
    }

    public setNode(node: BaseNode) {
        assert(!this.node || this.node === node, "node already set");
        this._node = node;
        this._semantic_version = (node as any).semantic_version;
        this._on_node_disposed_listener = () => this._on_node_disposed(this._node!);
        this._node.on("dispose", this._on_node_disposed_listener);
    }

    public setMonitoringMode(monitoringMode: MonitoringMode) {

        assert(monitoringMode !== MonitoringMode.Invalid);

        if (monitoringMode === this.monitoringMode) {
            // nothing to do
            return;
        }

        const old_monitoringMode = this.monitoringMode;

        this.monitoringMode = monitoringMode;

        if (this.monitoringMode === MonitoringMode.Disabled) {

            this._stop_sampling();

            // OPCUA 1.03 part 4 : $5.12.4
            // setting the mode to DISABLED causes all queued Notifications to be deleted
            this.queue = [];
            this.overflow = false;
        } else {
            assert(this.monitoringMode === MonitoringMode.Sampling || this.monitoringMode === MonitoringMode.Reporting);

            // OPCUA 1.03 part 4 : $5.12.1.3
            // When a MonitoredItem is enabled (i.e. when the MonitoringMode is changed from DISABLED to
            // SAMPLING or REPORTING) or it is created in the enabled state, the Server shall report the first
            // sample as soon as possible and the time of this sample becomes the starting point for the next
            // sampling interval.
            const recordInitialValue = (old_monitoringMode === MonitoringMode.Invalid ||
              old_monitoringMode === MonitoringMode.Disabled);

            this._start_sampling(recordInitialValue);

        }
    }

    /**
     * Terminate the  MonitoredItem.
     * @method terminate
     *
     * This will stop the internal sampling timer.
     */
    public terminate() {
        this._stop_sampling();
    }

    public dispose() {
        if (doDebug) {
            debugLog("DISPOSING MONITORED ITEM", this._node!.nodeId.toString());
        }

        this._stop_sampling();

        MonitoredItem.registry.unregister(this);

        if (this._on_node_disposed_listener) {
            this._node!.removeListener("dispose", this._on_node_disposed_listener);
            this._on_node_disposed_listener = null;
        }

        // x assert(this._samplingId === null,"Sampling Id must be null");
        this.oldDataValue = undefined;
        this.queue = [];
        this.itemToMonitor = null;
        this.filter = null;
        this.monitoredItemId = 0;
        this._node = null;
        this._semantic_version = 0;

        this.$subscription = null;

        this.removeAllListeners();

        assert(!this._samplingId);
        assert(!this._value_changed_callback);
        assert(!this._semantic_changed_callback);
        assert(!this._attribute_changed_callback);
        assert(!this._on_opcua_event_received_callback);
        this._on_opcua_event_received_callback = null;
        this._attribute_changed_callback = null;
        this._semantic_changed_callback = null;
        this._on_opcua_event_received_callback = null;

    }

    public get isSampling(): boolean {
        return !!this._samplingId || _.isFunction(this._value_changed_callback) ||
          _.isFunction(this._attribute_changed_callback);
    }

    /**
     * @param dataValue       the whole dataValue
     * @param skipChangeTest  indicates whether recordValue should  not check that dataValue is really
     *                                  different from previous one, ( by checking timestamps but also variant value)
     * @private
     *
     * Notes:
     *  - recordValue can only be called within timer event
     *  - for performance reason, dataValue may be a shared value with the underlying node,
     *    therefore recordValue must clone the dataValue to make sure it retains a snapshot
     *    of the contain at the time recordValue was called.
     *
     */
    public recordValue(
      dataValue: DataValue,
      skipChangeTest: boolean,
      indexRange?: NumericRange
    ) {

        assert(dataValue instanceof DataValue);
        assert(dataValue !== this.oldDataValue,
          "recordValue expects different dataValue to be provided");

        assert(!dataValue.value || dataValue.value !== this.oldDataValue!.value,
          "recordValue expects different dataValue.value to be provided");

        assert(!dataValue.value || dataValue.value.isValid(),
          "expecting a valid variant value");

        const hasSemanticChanged = this.node && ((this.node as any).semantic_version !== this._semantic_version);

        // xx   console.log("`\n----------------------------",skipChangeTest,this.clientHandle,
        //             this.node.listenerCount("value_changed"),this.node.nodeId.toString());
        // xx   console.log("events ---- ",this.node.eventNames().join("-"));
        // xx    console.log("indexRange = ",indexRange ? indexRange.toString() :"");
        // xx    console.log("this.itemToMonitor.indexRange = ",this.itemToMonitor.indexRange.toString());

        if (!hasSemanticChanged && indexRange && this.itemToMonitor.indexRange) {
            // we just ignore changes that do not fall within our range
            // ( unless semantic bit has changed )
            if (!NumericRange.overlap(indexRange as NumericalRange0, this.itemToMonitor.indexRange)) {
                return; // no overlap !
            }
        }

        assert(this.itemToMonitor, "must have a valid itemToMonitor(have this monitoredItem been disposed already ?");
        // extract the range that we are interested with
        dataValue = extractRange(dataValue, this.itemToMonitor.indexRange);

        // istanbul ignore next
        if (doDebug) {
            debugLog("MonitoredItem#recordValue",
              this.node!.nodeId.toString(),
              this.node!.browseName.toString(), " has Changed = ", !sameDataValue(dataValue, this.oldDataValue!));
        }

        // if semantic has changed, value need to be enqueued regardless of other assumptions
        if (hasSemanticChanged) {
            return this._enqueue_value(dataValue);
        }

        const useIndexRange = this.itemToMonitor.indexRange && !this.itemToMonitor.indexRange.isEmpty();

        if (!skipChangeTest) {
            const hasChanged = !sameDataValue(dataValue, this.oldDataValue!);
            if (!hasChanged) {
                return;
            }
        }

        if (!apply_filter.call(this, dataValue)) {
            return;
        }

        if (useIndexRange) {
            // when an indexRange is provided , make sure that no record happens unless
            // extracted variant in the selected range  has really changed.

            // istanbul ignore next
            if (doDebug) {
                debugLog("Current : ", this.oldDataValue!.toString());
                debugLog("New : ", dataValue.toString());
                debugLog("indexRange=", indexRange);
            }

            if (sameVariant(dataValue.value, this.oldDataValue!.value)) {
                return;
            }
        }
        // store last value
        this._enqueue_value(dataValue);

    }

    get hasMonitoredItemNotifications(): boolean {
        return this.queue.length > 0;
    }

    public extractMonitoredItemNotifications() {

        if (this.monitoringMode !== MonitoringMode.Reporting) {
            return [];
        }
        const notifications = this.queue;
        this._empty_queue();

        // apply semantic changed bit if necessary
        if (notifications.length > 0 && this.node && this._semantic_version < (this.node as any).semantic_version) {

            const dataValue = notifications[notifications.length - 1];
            setSemanticChangeBit(dataValue);
            this._semantic_version = (this.node as any).semantic_version;
        }

        return notifications;
    }

    public modify(
      timestampsToReturn: TimestampsToReturn,
      monitoringParameters: MonitoringParameters
    ): MonitoredItemModifyResult {

        assert(monitoringParameters instanceof MonitoringParameters);

        const old_samplingInterval = this.samplingInterval;

        this.timestampsToReturn = timestampsToReturn || this.timestampsToReturn;

        if (old_samplingInterval !== 0 && monitoringParameters.samplingInterval === 0) {
            monitoringParameters.samplingInterval = MonitoredItem.minimumSamplingInterval; // fastest possible
        }

        this._set_parameters(monitoringParameters);

        this._adjust_queue_to_match_new_queue_size();

        this._adjust_sampling(old_samplingInterval);

        if (monitoringParameters.filter) {
            const statusCodeFilter = validateFilter(monitoringParameters.filter, this.itemToMonitor, this.node!);
            if (statusCodeFilter.isNot(StatusCodes.Good)) {
                return new MonitoredItemModifyResult({
                    statusCode: statusCodeFilter
                });
            }
        }

        // validate filter
        // note : The DataChangeFilter does not have an associated result structure.
        const filterResult = null; // new subscription_service.DataChangeFilter

        return new MonitoredItemModifyResult({
            filterResult,
            revisedQueueSize: this.queueSize,
            revisedSamplingInterval: this.samplingInterval,
            statusCode: StatusCodes.Good
        });

    }

    public resendInitialValues() {
        // tte first Publish response(s) after the TransferSubscriptions call shall contain the current values of all
        // Monitored Items in the Subscription where the Monitoring Mode is set to Reporting.
        // the first Publish response after the TransferSubscriptions call shall contain only the value changes since
        // the last Publish response was sent.
        // This parameter only applies to MonitoredItems used for monitoring Attribute changes.
        this._stop_sampling();
        this._start_sampling(true);
    }

    /**
     * @method _on_sampling_timer
     * @private
     * request
     *
     */
    private _on_sampling_timer() {

        // istanbul ignore next
        if (doDebug) {
            debugLog("MonitoredItem#_on_sampling_timer",
              this.node ? this.node.nodeId.toString() : "null", " isSampling?=", this._is_sampling);
        }

        if (this._samplingId) {

            assert(this.monitoringMode === MonitoringMode.Sampling || this.monitoringMode === MonitoringMode.Reporting);

            if (this._is_sampling) {
                // previous sampling call is not yet completed..
                // there is nothing we can do about it except waiting until next tick.
                // note : see also issue #156 on github
                return;
            }
            // xx console.log("xxxx ON SAMPLING");
            assert(!this._is_sampling, "sampling func shall not be re-entrant !! fix it");

            if (!this.samplingFunc) {
                throw new Error("internal error : missing samplingFunc");
            }

            this._is_sampling = true;

            this.samplingFunc.call(this, this.oldDataValue!, (err: Error | null, newDataValue?: DataValue) => {

                if (!this._samplingId) {
                    // item has been dispose .... the monitored item has been disposed while the async sampling func
                    // was taking place ... just ignore this
                    return;
                }
                if (err) {
                    console.log(" SAMPLING ERROR =>", err);
                } else {
                    // only record value if source timestamp is newer
                    // xx if (newDataValue.sourceTimestamp > this.oldDataValue.sourceTimestamp) {
                    this._on_value_changed(newDataValue!);
                    // xx }
                }
                this._is_sampling = false;
            });

        } else {
            /* istanbul ignore next */
            debugLog("_on_sampling_timer call but MonitoredItem has been terminated !!! ");
        }
    }

    private _stop_sampling() {

        // debugLog("MonitoredItem#_stop_sampling");
        if (!this.node) {
            throw new Error("Internal Error");
        }
        if (this._on_opcua_event_received_callback) {
            assert(_.isFunction(this._on_opcua_event_received_callback));
            this.node.removeListener("event", this._on_opcua_event_received_callback);
            this._on_opcua_event_received_callback = null;
        }

        if (this._attribute_changed_callback) {
            assert(_.isFunction(this._attribute_changed_callback));

            const event_name = makeAttributeEventName(this.itemToMonitor.attributeId);
            this.node.removeListener(event_name, this._attribute_changed_callback);
            this._attribute_changed_callback = null;
        }

        if (this._value_changed_callback) {
            // samplingInterval was 0 for a exception-based data Item
            // we setup a event listener that we need to unwind here
            assert(_.isFunction(this._value_changed_callback));
            assert(!this._samplingId);

            this.node.removeListener("value_changed", this._value_changed_callback);
            this._value_changed_callback = null;
        }

        if (this._semantic_changed_callback) {
            assert(_.isFunction(this._semantic_changed_callback));
            assert(!this._samplingId);
            this.node.removeListener("semantic_changed", this._semantic_changed_callback);
            this._semantic_changed_callback = null;

        }
        if (this._samplingId) {
            this._clear_timer();
        }

        assert(!this._samplingId);
        assert(!this._value_changed_callback);
        assert(!this._semantic_changed_callback);
        assert(!this._attribute_changed_callback);
        assert(!this._on_opcua_event_received_callback);

    }

    private _on_value_changed(dataValue: DataValue, indexRange?: NumericRange) {
        assert(dataValue instanceof DataValue);
        this.recordValue(dataValue, false, indexRange);
    }

    private _on_semantic_changed() {
        const dataValue: DataValue = (this.node! as UAVariable).readValue();
        this._on_value_changed(dataValue);
    }

    private _on_opcua_event(eventData: EventData) {

        if (!this.filter || !(this.filter instanceof EventFilter)) {
            throw new Error("Internal Error");
        }

        const selectClauses = this.filter.selectClauses
          ? this.filter.selectClauses
          : ([] as SimpleAttributeOperand[]);

        const eventFields = extractEventFields(selectClauses, eventData);

        // istanbul ignore next
        if (doDebug) {
            console.log(" RECEIVED INTERNAL EVENT THAT WE ARE MONITORING");
            console.log(this.filter ? this.filter.toString() : "no filter");
            eventFields.forEach((e: any) => {
                console.log(e.toString());
            });
        }

        this._enqueue_event(eventFields);
    }

    private _getSession(): any {
        if (!this.$subscription) {
            return null;
        }
        if (!this.$subscription.$session) {
            return null;
        }
        return this.$subscription.$session;
    }

    private _start_sampling(recordInitialValue?: boolean) {

        if (!this.node) {
            throw new Error("Internal Error");
        }
        // make sure oldDataValue is scrapped so first data recording can happen
        this.oldDataValue = new DataValue({ statusCode: StatusCodes.BadDataUnavailable }); // unset initially

        this._stop_sampling();

        const context = new SessionContext({
            // xx  server: this.server,
            session: this._getSession()
        });

        if (this.itemToMonitor.attributeId === AttributeIds.EventNotifier) {

            // istanbul ignore next
            if (doDebug) {
                debugLog("xxxxxx monitoring EventNotifier on",
                  this.node.nodeId.toString(), this.node.browseName.toString());
            }
            // we are monitoring OPCUA Event
            this._on_opcua_event_received_callback = this._on_opcua_event.bind(this);
            this.node.on("event", this._on_opcua_event_received_callback);

            return;
        }
        if (this.itemToMonitor.attributeId !== AttributeIds.Value) {

            // sampling interval only applies to Value Attributes.
            this.samplingInterval = 0; // turned to exception-based regardless of requested sampling interval

            // non value attribute only react on value change
            this._attribute_changed_callback = this._on_value_changed.bind(this);
            const event_name = makeAttributeEventName(this.itemToMonitor.attributeId);

            this.node.on(event_name, this._attribute_changed_callback);

            if (recordInitialValue) {
                // read initial value
                const dataValue = this.node.readAttribute(context, this.itemToMonitor.attributeId);
                this.recordValue(dataValue, true);

            }
            return;
        }

        if (this.samplingInterval === 0) {

            // we have a exception-based dataItem : event based model, so we do not need a timer
            // rather , we setup the "value_changed_event";
            this._value_changed_callback = this._on_value_changed.bind(this);
            this._semantic_changed_callback = this._on_semantic_changed.bind(this);

            this.node.on("value_changed", this._value_changed_callback);
            this.node.on("semantic_changed", this._semantic_changed_callback);

            // initiate first read
            if (recordInitialValue) {
                (this.node as UAVariable).readValueAsync(context, (err: Error | null, dataValue?: DataValue) => {
                    if (!err && dataValue) {
                        this.recordValue(dataValue, true);
                    }
                });
            }
        } else {

            this._set_timer();
            if (recordInitialValue) {
                setImmediate(() => {
                    // xx console.log("Record Initial Value ",this.node.nodeId.toString());
                    // initiate first read (this requires this._samplingId to be set)
                    this._on_sampling_timer();
                });
            }
        }

    }

    private _set_parameters(monitoredParameters: MonitoringParameters) {
        _validate_parameters(monitoredParameters);
        this.clientHandle = monitoredParameters.clientHandle;

        // The Server may support data that is collected based on a sampling model or generated based on an
        // exception-based model. The fastest supported sampling interval may be equal to 0, which indicates
        // that the data item is exception-based rather than being sampled at some period. An exception-based
        // model means that the underlying system does not require sampling and reports data changes.
        if (this.node && this.node.nodeClass === NodeClass.Variable) {
            this.samplingInterval = _adjust_sampling_interval(monitoredParameters.samplingInterval,
              this.node ? (this.node as UAVariable).minimumSamplingInterval : 0);
        } else {
            this.samplingInterval = _adjust_sampling_interval(monitoredParameters.samplingInterval,
              0);
        }
        this.discardOldest = monitoredParameters.discardOldest;
        this.queueSize = _adjust_queue_size(monitoredParameters.queueSize);
    }

    private _setOverflowBit(notification: any) {

        if (notification.hasOwnProperty("value")) {
            assert(notification.value.statusCode.equals(StatusCodes.Good));
            notification.value.statusCode =
              StatusCodes.makeStatusCode(notification.value.statusCode, "Overflow | InfoTypeDataValue");
            assert(_.isEqual(notification.value.statusCode, StatusCodes.GoodWithOverflowBit));
            assert(notification.value.statusCode.hasOverflowBit);
        }
    }

    private _enqueue_notification(
      notification: MonitoredItemNotification | EventFieldList
    ) {

        if (this.queueSize === 1) {
            // ensure queuesize
            if (!this.queue || this.queue.length !== 1) {
                this.queue = [];
            }
            this.queue[0] = notification;
            assert(this.queue.length === 1);

        } else {
            if (this.discardOldest) {

                // push new value to queue
                this.queue.push(notification);

                if (this.queue.length > this.queueSize) {

                    this.overflow = true;

                    this.queue.shift(); // remove front element

                    // set overflow bit
                    this._setOverflowBit(this.queue[0]);
                }

            } else {
                if (this.queue.length < this.queueSize) {

                    this.queue.push(notification);
                } else {

                    this.overflow = true;

                    this._setOverflowBit(notification);

                    this.queue[this.queue.length - 1] = notification;
                }
            }
        }
        assert(this.queue.length >= 1);
    }

    private _makeDataChangeNotification(dataValue: DataValue): MonitoredItemNotification {
        const attributeId = this.itemToMonitor.attributeId;
        dataValue = apply_timestamps(dataValue, this.timestampsToReturn, attributeId);
        return new MonitoredItemNotification({
            clientHandle: this.clientHandle,
            value: dataValue
        });
    }

    /**
     * @method _enqueue_value
     * @param dataValue {DataValue} the dataValue to enquue
     * @private
     */
    private _enqueue_value(dataValue: DataValue) {

        // preconditions:

        assert(dataValue instanceof DataValue);
        // lets verify that, if status code is good then we have a valid Variant in the dataValue
        assert(!isGoodish(dataValue.statusCode) || dataValue.value instanceof Variant);
        // xx assert(isGoodish(dataValue.statusCode) || util.isNullOrUndefined(dataValue.value) );
        // let's check that data Value is really a different object
        // we may end up with corrupted queue if dataValue are recycled and stored as is in notifications
        assert(dataValue !== this.oldDataValue, "dataValue cannot be the same object twice!");

        // Xx // todo ERN !!!! PLEASE CHECK this !!!
        // Xx // let make a clone, so we have a snapshot
        // Xx dataValue = dataValue.clone();

        // let's check that data Value is really a different object
        // we may end up with corrupted queue if dataValue are recycled and stored as is in notifications
        assert(!this.oldDataValue || !dataValue.value || (dataValue.value !== this.oldDataValue.value),
          "dataValue cannot be the same object twice!");

        if (!(!this.oldDataValue || !this.oldDataValue.value
          || !dataValue.value || !(dataValue.value.value instanceof Object)
          || (dataValue.value.value !== this.oldDataValue.value.value)) && !(dataValue.value.value instanceof Date)) {
            throw new Error("dataValue.value.value cannot be the same object twice! "
              + this.node!.browseName.toString() + " " + dataValue.toString() + "  " +
              chalk.cyan(this.oldDataValue.toString()));
        }

        // istanbul ignore next
        if (doDebug) {
            debugLog("MonitoredItem#_enqueue_value", this.node!.nodeId.toString());
        }

        this.oldDataValue = dataValue;
        const notification = this._makeDataChangeNotification(dataValue);
        this._enqueue_notification(notification);
    }

    private _makeEventFieldList(eventFields: any[]): EventFieldList {
        assert(_.isArray(eventFields));
        return new EventFieldList({
            clientHandle: this.clientHandle,
            eventFields
        });
    }

    private _enqueue_event(eventFields: any[]) {
        if (doDebug) {
            debugLog(" MonitoredItem#_enqueue_event");
        }
        const notification = this._makeEventFieldList(eventFields);
        this._enqueue_notification(notification);
    }

    private _empty_queue() {
        // empty queue
        this.queue = [];
        this.overflow = false;
    }

    private _clear_timer() {

        if (this._samplingId) {
            if (useCommonTimer) {
                removeFromTimer(this);
            } else {
                clearInterval(this._samplingId as NodeJS.Timer);
            }
            this._samplingId = undefined;
        }
    }

    private _set_timer() {

        assert(this.samplingInterval >= MonitoredItem.minimumSamplingInterval);
        assert(!this._samplingId);

        if (useCommonTimer) {
            this._samplingId = appendToTimer(this);
        } else {
            // settle periodic sampling
            this._samplingId = setInterval(() => {
                this._on_sampling_timer();
            }, this.samplingInterval);
        }
        // xx console.log("MonitoredItem#_set_timer",this._samplingId);
    }

    private _adjust_queue_to_match_new_queue_size() {

        // adjust queue size if necessary
        if (this.queueSize < this.queue.length) {

            if (this.discardOldest) {
                this.queue.splice(0, this.queue.length - this.queueSize);
            } else {

                const lastElement = this.queue[this.queue.length - 1];
                // only keep queueSize first element, discard others
                this.queue.splice(this.queueSize);
                this.queue[this.queue.length - 1] = lastElement;
            }
        }
        if (this.queueSize <= 1) {
            this.overflow = false;
            // unset OverFlowBit
            if (this.queue.length === 1) {
                if (this.queue[0] instanceof MonitoredItemNotification) {

                    const el = this.queue[0] as MonitoredItemNotification;
                    if (el.value.statusCode.hasOverflowBit) {
                        (el.value.statusCode as any).unset("Overflow | InfoTypeDataValue");
                    }
                }
            }
        }
        assert(this.queue.length <= this.queueSize);
    }

    private _adjust_sampling(old_samplingInterval: number) {
        if (old_samplingInterval !== this.samplingInterval) {
            this._start_sampling(false);
        }
    }

    private _on_node_disposed(node: BaseNode) {
        this._on_value_changed(new DataValue({
            sourceTimestamp: new Date(),
            statusCode: StatusCodes.BadNodeIdInvalid
        }));
        this._stop_sampling();
        node.removeListener("dispose", this._on_node_disposed_listener);
        this._on_node_disposed_listener = null;
    }

}
