import cs from "./cs.json";

const dict: Record<string, string> = cs;

export function t(key: string, params?: Record<string, string | number>): string {
    let val = dict[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            val = val.replace(`{${k}}`, String(v));
        }
    }
    return val;
}
