/**
 * QoderAdapter — shape type for the Qoder provider adapter.
 *
 * The driver model ({@link ../Drivers/QoderDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module QoderAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * QoderAdapterShape — per-instance Qoder adapter contract.
 */
export interface QoderAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
