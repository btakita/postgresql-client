import arrayParser from 'postgres-array';
import {DataType} from '../definitions';


export const Float4Type: DataType = {

    parse(v: string, isArray?: boolean): number | number[] {
        if (isArray)
            return arrayParser.parse(v, parseFloat);
        return parseFloat(v);
    },

    decode(v: Buffer): number {
        return v.readFloatBE(0);
    },

    encode(v: number | string): string | Buffer {
        const buf = Buffer.allocUnsafe(4);
        buf.writeFloatBE(typeof v === 'number' ? v : parseFloat(v));
        return buf;
    },

    isType(v: any): boolean {
        return typeof v === 'number';
    }

}