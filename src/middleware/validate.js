// Generic Zod validation middleware. Attaches parsed data at req.valid.
export function validate(schema, source = 'body') {
    return (req, _res, next) => {
        const result = schema.safeParse(req[source]);
        if (!result.success) return next(result.error);
        req.valid = result.data;
        next();
    };
}
