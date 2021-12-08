import { interval, Observable, Subject, Subscription } from 'rxjs';
import { distinctUntilChanged, filter, takeWhile } from 'rxjs/operators';
import { WebSocketSubject } from 'rxjs/webSocket';
import Go from './wasm-exec';
import Verse from './verse';
import { WebSocketMessage, YoMoClientOption } from './type';

export default class YoMoClient<T> extends Subject<T> {
    private url: string;
    private verseMap: Map<string, Verse>;
    private socket$: WebSocketSubject<WebSocketMessage> | undefined;
    private socketSubscription: Subscription | undefined;

    // Reconnection stream
    private reconnectionObservable: Observable<number> | undefined;
    private reconnectionSubscription: Subscription | undefined;
    private reconnectInterval: number;
    private reconnectAttempts: number;

    private connectionStatus$: Subject<boolean>;

    private wasmLoaded: boolean;

    public connection: {
        on: (event: 'connected' | 'closed', cb: () => void) => void;
        close: () => void;
    };

    constructor(url: string, option: YoMoClientOption) {
        if (!isWSProtocol(getProtocol(url))) {
            throw new Error(
                `${url} -> The URL's scheme must be either 'ws' or 'wss'`
            );
        }

        super();
        this.url = url;
        this.reconnectInterval = option.reconnectInterval || 5000;
        this.reconnectAttempts = option.reconnectAttempts || 5;
        this.connectionStatus$ = new Subject<boolean>();
        this.connectionStatus$.subscribe({
            next: isConnected => {
                if (
                    !this.reconnectionObservable &&
                    typeof isConnected === 'boolean' &&
                    !isConnected
                ) {
                    this.reconnect();
                }
            },
        });

        this.wasmLoaded = false;

        this.verseMap = new Map<string, Verse>();

        this.connection = {
            close: this.close.bind(this),
            on: this.on.bind(this),
        };

        this.connect();
    }

    to(verseId: string): Verse {
        const verse = this.verseMap.get(verseId);
        if (verse) {
            return verse;
        }

        return this.createVerse(verseId, this.socket$);
    }

    private on(event: 'connected' | 'closed', cb: () => void): void {
        this.connectionStatus$
            .pipe(
                distinctUntilChanged(),
                filter(isConnected => {
                    return (
                        (isConnected && event === 'connected') ||
                        (!isConnected && event === 'closed')
                    );
                })
            )
            .subscribe(() => {
                cb && cb();
            });
    }

    /**
     * Close subscriptions, clean up.
     */
    private close(): void {
        // call 'close', don't reconnect
        this.reconnectAttempts = 0;
        this.clearSocket();
        this.connectionStatus$.next(false);
    }

    private createVerse(
        verseId: string,
        socket$: WebSocketSubject<WebSocketMessage> | undefined
    ) {
        const verse = new Verse(verseId, socket$);
        this.verseMap.set(verseId, verse);
        return verse;
    }

    /**
     * connect.
     * @private
     */
    private async connect() {
        if (!this.wasmLoaded) {
            try {
                await loadWasm('https://d1lxb757x1h2rw.cloudfront.net/y3.wasm');
                this.wasmLoaded = true;
            } catch (error) {
                throw error;
            }
        }

        const tag = 0x11;

        const serializer = (data: any) => {
            return (window as any).encode(tag, data).buffer;
        };

        const deserializer = (event: MessageEvent) => {
            const uint8buf = new Uint8Array(event.data);
            return (window as any).decode(tag, uint8buf);
        };

        this.socket$ = new WebSocketSubject({
            url: this.url,
            serializer,
            deserializer,
            binaryType: 'arraybuffer',
            openObserver: {
                next: () => {
                    this.connectionStatus$.next(true);
                },
            },
            closeObserver: {
                next: () => {
                    this.clearSocket();
                    this.connectionStatus$.next(false);
                },
            },
        });

        this.socketSubscription = this.socket$.subscribe({
            next: (msg: any) => {
                this.next(msg);
            },
            error: () => {
                if (!this.socket$) {
                    this.clearReconnection();
                    this.reconnect();
                }
            },
        });
    }

    /**
     * reconnect.
     *
     * @private
     */
    private reconnect(): void {
        this.reconnectionObservable = interval(this.reconnectInterval).pipe(
            takeWhile(
                (_, index) => index < this.reconnectAttempts && !this.socket$
            )
        );

        this.reconnectionSubscription = this.reconnectionObservable.subscribe({
            next: () => this.connect(),
            error: () => undefined,
            complete: () => {
                this.clearReconnection();
                if (!this.socket$) {
                    this.complete();
                    this.connectionStatus$.complete();
                }
            },
        });
    }

    /**
     * clear socket.
     *
     * @private
     */
    private clearSocket(): void {
        this.socketSubscription && this.socketSubscription.unsubscribe();
        this.socket$ = undefined;
    }

    /**
     * clear reconnect.
     *
     * @private
     */
    private clearReconnection(): void {
        this.reconnectionSubscription &&
            this.reconnectionSubscription.unsubscribe();
        this.reconnectionObservable = undefined;
    }
}

/**
 * check if the URL scheme is 'ws' or 'wss'
 *
 * @param protocol - URL's scheme
 */
function isWSProtocol(protocol: string): boolean {
    return protocol === 'ws' || protocol === 'wss';
}

/**
 * get URL's scheme
 *
 * @param url - the url of the socket server to connect to
 */
function getProtocol(url: string) {
    if (!url) {
        return '';
    }

    return url.split(':')[0];
}

/**
 * @param {RequestInfo} path wasm file path
 */
async function loadWasm(path: RequestInfo): Promise<void> {
    // This is a polyfill for FireFox and Safari
    if (!WebAssembly.instantiateStreaming) {
        WebAssembly.instantiateStreaming = async (resp, importObject) => {
            const source = await (await resp).arrayBuffer();
            return await WebAssembly.instantiate(source, importObject);
        };
    }

    const go = new Go();

    go.importObject.env['syscall/js.finalizeRef'] = () => {};

    try {
        const result = await WebAssembly.instantiateStreaming(
            fetch(path),
            go.importObject
        );

        go.run(result.instance);
    } catch (error) {
        return Promise.reject(error);
    }
}