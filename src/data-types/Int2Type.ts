import arrayParser from 'postgres-array';
import {fastParseInt} from '../helpers';
import {DataType} from '../definitions';

export const Int2Type: DataType = {

    parse(v: string, isArray?: boolean): number | number[] {
        if (isArray)
            return arrayParser.parse(v, fastParseInt);
        return fastParseInt(v);
    },

    decode(v: Buffer): number {
        return v.readInt16BE(0);
    },

    encode(v: string): Buffer {
        const buf = Buffer.allocUnsafe(2);
        buf.writeInt16BE(fastParseInt(v));
        return buf;
    },

    isType(v: any): boolean {
        return typeof v === 'number';
    }

}