import { IAuthProvider, SearchParams, toQueryString } from "shared/mod.ts";
import { JSONValue } from "api/general.types.ts";

type SpotifyRegularError = {
	error: {
		/**
		 * A short description of the cause of the error.
		 */
		message: string;
		/**
		 * The HTTP status code that is also returned in the response header.
		 */
		status: number;
	};
};

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * Options for fetch method on HTTPClient interface
 */
export interface FetchOpts {
	method?: HTTPMethod;
	/**
	 * Json object that will be stringified and passed to the body of the request.
	 * Will be ignored if `body` is specified.
	 */
	json?: JSONValue;
	/**
	 * Query parameters or, more precisely, search parameters that will be converted into a query string and passed to the url.
	 */
	query?: SearchParams;
	/**
	 * Custom headers that will be passed to the request and overwrite existing ones
	 */
	headers?: HeadersInit;
	/**
	 * Request body. Will overwrite `json` property if specified.
	 */
	body?: BodyInit;
}

export type ExpectedResponse = "json" | "void";

/**
 * Interface that provides a fetch method to make HTTP requests to Spotify API.
 */
export interface HTTPClient {
	/**
	 * Sends an HTTP request.
	 *
	 * @param baseURL
	 * The base URL for the API request. Must begin with "/"
	 * @param returnType
	 * The expected return type of the API response.
	 * @param opts
	 * Optional request options, such as the request body or query parameters.
	 */
	fetch(
		baseURL: string,
		responseType: "void",
		opts?: FetchOpts,
	): Promise<void>;
	fetch<
		R extends JSONValue = JSONValue,
	>(
		baseURL: string,
		responseType: "json",
		opts?: FetchOpts,
	): Promise<R>;
}

/**
 * The Spotify client will throw this error if the api response is not "ok" (status >= 400)
 */
export class SpotifyError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "SpotifyError";
	}
}

export interface SpotifyClientOpts {
	/**
	 * How many times do you want to try again until you throw the error
	 *
	 * @default 0
	 */
	retryTimesOn5xx?: number;
	/**
	 * How long in miliseconds do you want to wait until the next retry
	 *
	 * @default 0
	 */
	retryDelayOn5xx?: number;
	/**
	 * If it is set to true, it would refetch the same request after a paticular time interval sent by the spotify api in the headers `Retry-After` so you cannot face any obstacles.
	 * Otherwise, it will throw an error.
	 *
	 * @default false
	 */
	retryOnRateLimit?: boolean;
}

/**
 * A client for making requests to the Spotify API.
 */
export class SpotifyClient implements HTTPClient {
	private BASE_HEADERS: HeadersInit = {
		"Content-Type": "application/json",
		"Accept": "application/json",
	};

	/**
	 * @param authProvider It is recommended to pass a class that implements `IAuthProvider` to automatically update tokens. If you do not need this behavior,you can simply pass an access token.
	 * @param opts Additional options for fetch execution, such as the ability to retry on error
	 */
	constructor(
		private authProvider: IAuthProvider | string,
		private readonly opts: SpotifyClientOpts = {
			retryOnRateLimit: false,
			retryDelayOn5xx: 0,
			retryTimesOn5xx: 0,
		},
	) {}

	/**
	 * Method that changes the existing authProvider to the specified one
	 */
	setAuthProvider(authProvider: IAuthProvider | string) {
		this.authProvider = authProvider;
	}

	fetch(
		baseURL: string,
		hasResponse: "void",
		opts?: FetchOpts,
	): Promise<void>;
	fetch<
		R extends JSONValue = JSONValue,
	>(
		baseURL: string,
		responseType: "json",
		opts?: FetchOpts,
	): Promise<R>;
	async fetch<
		R extends JSONValue = JSONValue,
	>(
		baseURL: string,
		responseType: ExpectedResponse,
		{ json, query, method, headers, body }: FetchOpts = {},
	): Promise<R | void> {
		const url = new URL("https://api.spotify.com/v1" + baseURL);
		if (query) {
			url.search = toQueryString(query);
		}

		const _body = body ? body : json ? JSON.stringify(json) : undefined;
		const _headers = new Headers(this.BASE_HEADERS);
		if (headers) {
			Object.entries(headers).forEach(([name, value]) =>
				_headers.append(name, value)
			);
		}

		let isTriedRefreshToken = false;
		let retryTimesOn5xx = this.opts.retryTimesOn5xx;

		let accessToken = typeof this.authProvider === "object"
			? this.authProvider.getToken()
			: this.authProvider;

		const call = async (): Promise<Response> => {
			_headers.set("Authorization", "Bearer " + accessToken);

			const res = await fetch(url, {
				method,
				headers: _headers,
				body: _body,
			});

			if (res.ok) return res;

			if (
				res.status === 401 && typeof this.authProvider === "object" &&
				!isTriedRefreshToken
			) {
				accessToken = await this.authProvider.refreshToken();
				isTriedRefreshToken = true;
				return call();
			}

			if (res.status === 429 && this.opts.retryOnRateLimit) {
				// time in seconds
				const retryAfter = Number(res.headers.get("Retry-After"));

				if (retryAfter) {
					await new Promise((r) => setTimeout(r, retryAfter * 1000));
					return call();
				}
			}

			if (res.status.toString().startsWith("5") && retryTimesOn5xx) {
				if (this.opts.retryDelayOn5xx) {
					await new Promise((r) => setTimeout(r, this.opts.retryDelayOn5xx));
				}

				retryTimesOn5xx--;
				return call();
			}

			let message: string;

			if (!res.body) {
				message = "null";
			} else {
				const text = await res.text();
				try {
					message = (JSON.parse(text) as SpotifyRegularError).error.message;
				} catch (_) {
					message = text;
				}
			}

			throw new SpotifyError(
				message,
				res.status,
			);
		};

		const res = await call();

		if (responseType === "json") {
			if (!res.body) throw new Error("Body not found");
			return await res.json() as R;
		}

		if (res.body) await res.body.cancel();
	}
}
