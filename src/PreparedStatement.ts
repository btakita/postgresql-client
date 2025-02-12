import {
    AnyParseFunction,
    CommandResult, DEFAULT_COLUMN_FORMAT,
    FieldInfo,
    Maybe,
    OID,
    QueryOptions,
    QueryResult,
    StatementPrepareOptions
} from './definitions';
import {Connection} from './Connection';
import {SafeEventEmitter} from './SafeEventEmitter';
import {Protocol} from './protocol/protocol';
import {Cursor} from './Cursor';
import {Portal} from './Portal';
import {convertRowToObject, getIntlConnection, getParsers, parseRow, wrapRowDescription} from './common';
import {GlobalTypeMap} from './DataTypeMap';
import {coerceToBoolean} from "putil-varhelpers";
import _debug from 'debug';

const debug = _debug('pgc:statement');

let statementCounter = 0;
let portalCounter = 0;

export class PreparedStatement extends SafeEventEmitter {
    private readonly _connection: Connection;
    private readonly _sql: string = '';
    private readonly _name: string = '';
    private readonly _paramTypes: Maybe<Maybe<OID>[]>;
    protected _onErrorSavePoint: string;
    private _refCount = 0;

    constructor(connection: Connection, sql: string, paramTypes?: OID[]) {
        super();
        this._connection = connection;
        this._name = 'S_' + (++statementCounter);
        this._sql = sql;
        this._paramTypes = paramTypes;
        this._onErrorSavePoint = 'SP_' + (Math.round(Math.random() * 100000000));
    }

    static async prepare(connection: Connection,
                         sql: string,
                         options?: StatementPrepareOptions): Promise<PreparedStatement> {
        const intoCon = getIntlConnection(connection);
        intoCon.assertConnected();
        const socket = intoCon.socket;
        const statement = new PreparedStatement(connection, sql, options?.paramTypes);
        await intoCon.statementQueue.enqueue<void>(async () => {
            intoCon.ref();
            try {
                socket.sendParseMessage({
                    statement: statement.name,
                    sql: statement.sql,
                    paramTypes: statement.paramTypes
                });
                socket.sendFlushMessage();
                try {
                    await socket.capture(async (code: Protocol.BackendMessageCode, msg: any, done: (err?: Error, result?: CommandResult) => void) => {
                        switch (code) {
                            case Protocol.BackendMessageCode.NoticeResponse:
                                break;
                            case Protocol.BackendMessageCode.ParseComplete:
                                done();
                                break;
                            default:
                                done(new Error(`Server returned unexpected response message (0x${code.toString(16)})`));
                        }
                    });
                } finally {
                    socket.sendSyncMessage();
                    await socket.capture(async (code: Protocol.BackendMessageCode, msg: any, done: (err?: Error, result?: CommandResult) => void) => {
                        switch (code) {
                            case Protocol.BackendMessageCode.NoticeResponse:
                                break;
                            case Protocol.BackendMessageCode.ReadyForQuery:
                                done();
                                break;
                            default:
                                done(new Error(`Server returned unexpected response message (0x${code.toString(16)})`));
                        }
                    });
                }
                debug('[%s] prepared | %s', statement.name, sql);
            } finally {
                intoCon.unref();
            }
        });
        statement._refCount = 1;
        return statement;
    }

    get connection(): Connection {
        return this._connection;
    }

    get name(): Maybe<string> {
        return this._name;
    }

    get sql(): string {
        return this._sql;
    }

    get paramTypes(): Maybe<Maybe<OID>[]> {
        return this._paramTypes;
    }

    async execute(options: QueryOptions = {}): Promise<QueryResult> {
        debug('[%s] execute', this.name);
        const intlCon = getIntlConnection(this.connection);

        const transactionCommand = this.sql.match(/^(\bBEGIN\b|\bCOMMIT\b|\bROLLBACK|SAVEPOINT|RELEASE\b)/i);
        let beginFirst = false;
        let commitLast = false;
        if (!transactionCommand) {
            if (!intlCon.inTransaction &&
                (options?.autoCommit != null ? options?.autoCommit : intlCon.config.autoCommit) === false) {
                beginFirst = true;
            }
            if (intlCon.inTransaction && options?.autoCommit)
                commitLast = true;
        }
        if (beginFirst)
            await intlCon.execute('BEGIN');

        const onErrorRollback = !transactionCommand &&
            (options?.onErrorRollback != null ? options.onErrorRollback :
                coerceToBoolean(intlCon.config.onErrorRollback, true));

        if (intlCon.inTransaction && onErrorRollback)
            await intlCon.execute('SAVEPOINT ' + this._onErrorSavePoint);
        try {
            const result = await intlCon.statementQueue.enqueue<QueryResult>(() =>
                this._execute(options));
            if (commitLast)
                await intlCon.execute('COMMIT');
            else if (intlCon.inTransaction && onErrorRollback)
                await intlCon.execute('RELEASE ' + this._onErrorSavePoint + ';');
            return result;
        } catch (e: any) {
            if (intlCon.inTransaction && onErrorRollback)
                await intlCon.execute('ROLLBACK TO ' + this._onErrorSavePoint + ';');
            throw e;
        }
    }

    async close(): Promise<void> {
        --this._refCount;
        debug('[%s] close | refCount = %d', this.name, this._refCount);
        if (this._refCount > 0) return;
        const intoCon = getIntlConnection(this.connection);
        await intoCon.statementQueue.enqueue<void>(() => this._close());
    }

    async cancel(): Promise<void> {
        throw new Error('Not implemented yet');
    }

    protected async _execute(options: QueryOptions = {}): Promise<QueryResult> {
        let portal: Maybe<Portal>;
        const intlCon = getIntlConnection(this.connection);
        debug('[%s] _execute', this.name);
        intlCon.ref();
        try {
            const result: QueryResult = {command: undefined};
            const startTime = Date.now();
            const t = Date.now();

            // Create portal
            const portalName = 'P_' + (++portalCounter);
            portal = new Portal(this, portalName);

            await portal.bind(options.params, options);
            const fields = await portal.retrieveFields();

            const typeMap = options.typeMap || GlobalTypeMap;
            let parsers: Maybe<AnyParseFunction[]>;
            let resultFields: Maybe<FieldInfo[]>;

            if (fields) {
                parsers = getParsers(typeMap, fields);
                resultFields = wrapRowDescription(typeMap, fields, options.columnFormat || DEFAULT_COLUMN_FORMAT);
                result.fields = resultFields;
                result.rowType = options.objectRows ? 'object' : 'array';
                if (options.cursor) {
                    result.cursor = new Cursor(
                        this,
                        portal,
                        resultFields,
                        parsers,
                        options);
                    this._refCount++;
                    portal = undefined;
                    return result;
                }
            }
            const executeResult = await portal.execute(options.fetchCount);
            result.executeTime = Date.now() - t;
            if (executeResult.command)
                result.command = executeResult.command;
            if (resultFields && parsers && executeResult.rows) {
                if (!result.command)
                    result.command = 'SELECT';
                const rows = result.rows = executeResult.rows;
                const l = rows.length;
                let row;
                for (let i = 0; i < l; i++) {
                    row = rows[i];
                    parseRow(parsers, row, options);
                    if (options.objectRows) {
                        rows[i] = convertRowToObject(resultFields, row);
                    }
                }
            }
            if (result.command === 'DELETE' ||
                result.command === 'INSERT' ||
                result.command === 'UPDATE')
                result.rowsAffected = executeResult.rowCount;

            result.executeTime = Date.now() - startTime;

            return result;
        } finally {
            intlCon.unref();
            if (portal)
                await portal.close();
        }
    }

    protected async _close(): Promise<void> {
        if (--this._refCount > 0) return;
        const intoCon = getIntlConnection(this.connection);
        intoCon.ref();
        try {
            const socket = intoCon.socket;
            socket.sendCloseMessage({type: 'S', name: this.name});
            socket.sendSyncMessage();
            await socket.capture(async (code: Protocol.BackendMessageCode, msg: any, done: (err?: Error) => void) => {
                switch (code) {
                    case Protocol.BackendMessageCode.NoticeResponse:
                        this.emit('notice', msg);
                        break;
                    case Protocol.BackendMessageCode.CloseComplete:
                        break;
                    case Protocol.BackendMessageCode.ReadyForQuery:
                        intoCon.transactionStatus = msg.status;
                        done();
                        break;
                    default:
                        done(new Error(`Server returned unexpected response message (0x${code.toString(16)})`));
                }
            });
        } finally {
            intoCon.unref();
        }
        debug('[%s] closed');
        this.emit('close');
    }

}

