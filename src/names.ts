const maxLength = 64;

export function validName(value: string): boolean {
    return value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function normalizeName(value: string, defaultName: string): string {
    return (
        value
            .replace(/[^A-Za-z0-9._-]/g, "-")
            .replace(/^[^A-Za-z0-9]+/, "")
            .slice(0, maxLength) || defaultName
    );
}
