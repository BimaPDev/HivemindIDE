/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind shell: routes, and the runtime overlay that declares them.
 *
 *  A route is one provider + one model. The user's providers
 *  (`hivemindide.failover.providers`) are the route table: each becomes a
 *  provider route in the runtime, its models the routes under it. Keys never
 *  enter the overlay; each provider's key is handed to the runtime in its own
 *  environment variable, which the overlay names.
 *
 *  Pure functions, so they can be tested from node without a workbench.
 *--------------------------------------------------------------------------------------------*/

import { IFailoverProvider } from './providerFailover.js';

/** Auto (by task) and combos: routes that pick among the others. */
export const SHELL_MODELS_VENDOR = 'hivemind-shell';

/**
 * The model picker lists each kind of route under its own heading, one vendor
 * per kind: models on this machine, installed agent CLIs, and API services.
 */
export const ROUTE_VENDORS = {
	hivemind: SHELL_MODELS_VENDOR,
	local: 'hivemind-local',
	cli: 'hivemind-cli',
	service: 'hivemind-service',
} as const;
export type RouteGroup = keyof typeof ROUTE_VENDORS;

/** The provider name of the user's local models (llama.cpp here, or their remote llama server). */
export const LOCAL_ROUTE_PROVIDER = 'Local';

export interface IShellRoute {
	/** `provider/model`: what nodes record and the model picker identifies. */
	readonly id: string;
	readonly provider: string;
	readonly model: string;
}

/** Every route the providers declare, in the user's order. */
export function shellRoutes(providers: readonly IFailoverProvider[]): IShellRoute[] {
	return providers.flatMap(p => providerModels(p).map(model => ({ id: routeId(p.name, model), provider: p.name, model })));
}

/** Routes for local models, named by the model; listed before the providers' routes. */
export function localRoutes(modelNames: readonly string[]): IShellRoute[] {
	return [...new Set(modelNames)].map(model => ({ id: routeId(LOCAL_ROUTE_PROVIDER, model), provider: LOCAL_ROUTE_PROVIDER, model }));
}

export function isLocalRoute(route: IShellRoute): boolean {
	return route.provider === LOCAL_ROUTE_PROVIDER;
}

/** An OpenAI-compatible base URL: llama.cpp and Ollama are given without the `/v1` the protocol needs. */
export function openAiBaseUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, '');
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function routeId(provider: string, model: string): string {
	return `${provider}/${model}`;
}

export function findRoute(routes: readonly IShellRoute[], id: string | undefined): IShellRoute | undefined {
	return id ? routes.find(r => r.id === id) : undefined;
}

export function shellModelIdentifier(route: IShellRoute, group: RouteGroup = 'hivemind'): string {
	return `${ROUTE_VENDORS[group]}/${route.id}`;
}

/** The route id inside a model-picker identifier, when the picker chose one of the routes. */
export function routeIdFromModelIdentifier(identifier: string | undefined): string | undefined {
	const vendor = Object.values(ROUTE_VENDORS).find(v => identifier?.startsWith(`${v}/`));
	return vendor ? identifier!.slice(vendor.length + 1) : undefined;
}

function providerModels(provider: IFailoverProvider): string[] {
	return [...new Set([provider.model, ...(provider.models ?? [])].filter(Boolean))];
}

/**
 * The key sent to a provider that has none. The runtime will not call an
 * OpenAI-compatible route without a key, and keyless servers (Ollama,
 * llama.cpp started without one) ignore whatever is sent.
 */
export const KEYLESS_PLACEHOLDER = 'none';

/** The environment variable carrying the key of the provider at `index`. */
export function keyVariable(index: number): string {
	return `HIVE_ROUTE_KEY_${index}`;
}

export interface IShellOverlay {
	/** Profile patch entries: the provider routes and the default route. */
	readonly overlay: object[];
	/** Provider name → the variable its key must be set in. */
	readonly keyVariables: ReadonlyMap<string, string>;
}

/**
 * The runtime overlay for `providers`. Every route speaks the OpenAI chat
 * completions protocol at the provider's URL, which is what the providers
 * setting already promises. `defaultRoute` is where a new session starts.
 */
export function buildShellOverlay(providers: readonly IFailoverProvider[], defaultRoute: IShellRoute | undefined): IShellOverlay {
	const keyVariables = new Map<string, string>();
	const routes: Record<string, object> = {};
	providers.forEach((provider, index) => {
		keyVariables.set(provider.name, keyVariable(index));
		routes[provider.name] = {
			displayName: provider.name,
			api: 'openai-completions',
			baseURL: openAiBaseUrl(provider.url),
			apiKeyEnv: keyVariable(index),
			models: providerModels(provider).map(id => ({ id })),
		};
	});
	const overlay: object[] = [{ id: 'llm-pi-ai', config: { providers: routes } }];
	if (defaultRoute) {
		const route = { provider: defaultRoute.provider, model: defaultRoute.model };
		// Sessions start on it, and so do agents the runtime creates for itself.
		overlay.push({ id: 'acp', config: route }, { id: 'agent-default-model', config: route });
	}
	return { overlay, keyVariables };
}

/**
 * The runtime's opaque option value for `route`. The runtime encodes a route
 * as the JSON array `["provider","model"]`; the display name is the fallback
 * should that encoding change.
 */
export function findRouteChoice(choices: readonly { readonly value: string; readonly name: string; readonly group?: string }[], route: IShellRoute): string | undefined {
	for (const choice of choices) {
		try {
			const parsed = JSON.parse(choice.value);
			if (Array.isArray(parsed) && parsed[0] === route.provider && parsed[1] === route.model) {
				return choice.value;
			}
		} catch {
			// not the JSON encoding
		}
	}
	return choices.find(c => c.name === route.model && (c.group === undefined || c.group === route.provider))?.value;
}
