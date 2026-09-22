import { routingApi } from "../api/routingOverrides";
import { getBundleInstances, saveBundleInstances } from "./bundleStorage";
import { createBundleController } from "../utils/bundleController";
export const bundleController = createBundleController(routingApi, { load: getBundleInstances, save: saveBundleInstances });
