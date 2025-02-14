// copyright defined in LICENSE.txt

'use strict';

const fs = require('fs');
const schema = 'chain';

const type_map = {
    'bool': 'bool',
    'varuint32': 'bigint',
    'varint32': 'integer',
    'uint8': 'smallint',
    'uint16': 'integer',
    'uint32': 'bigint',
    'uint64': 'decimal',
    'uint128': 'decimal',
    'int8': 'smallint',
    'int16': 'smallint',
    'int32': 'integer',
    'int64': 'bigint',
    'int128': 'decimal',
    'double': 'float8',
    'float128': 'bytea',
    'name': 'varchar(13)',
    'string': 'varchar',
    'time_point': 'timestamp',
    'time_point_sec': 'timestamp',
    'block_timestamp_type': 'timestamp',
    'checksum256': 'varchar(64)',
    'public_key': 'varchar',
    'bytes': 'bytea',
    'transaction_status': 'transaction_status_type',
};

const empty_value_map = {
    "bool": "false",
    "varuint32": "0",
    "varint32": "0",
    "uint8": "0",
    "uint16": "0",
    "uint32": "0",
    "uint64": "0",
    "uint128": "0",
    "int8": "0",
    "int16": "0",
    "int32": "0",
    "int64": "0",
    "int128": "0",
    "double": "0",
    "float128": "''",
    "name": "''",
    "string": "''",
    "time_point": "null",
    "time_point_sec": "null",
    "block_timestamp_type": "null",
    "checksum256": "''",
    "public_key": "''",
    "bytes": "''",
    "transaction_status": "''",
};

const header = ``;
let indexes = '';
let functions = '';

function sort_key_arg_expr(key, prefix) {
    if (key.arg_expression) {
        const expr = key.arg_expression.replace('${prefix}', prefix).replace('${schema}', schema);
        return expr;
    } else {
        return '"' + prefix + key.name + '"';
    }
}

function sort_key_expr(key, prefix, rename) {
    if (key.expression) {
        const expr = key.expression.replace('${prefix}', prefix).replace('${schema}', schema);
        if (rename)
            return expr + ' as ' + '"' + key.name + '"';
        else
            return expr;
    } else {
        return prefix + '"' + key.name + '"';
    }
}

function generate_index({ table, index, sort_keys, history_keys, conditions }) {
    if (!index)
        return;
    indexes += `
        create index if not exists ${index} on ${schema}.${table}(
            ${sort_keys.map(x => sort_key_expr(x, '', false)).concat(history_keys.map(x => `"${x.name + (x.desc ? '" desc' : '"')}`)).join(',\n            ')}
        )`;
    if (conditions)
        indexes += '\n        where\n            ' + conditions.join('\n            and ');
    indexes += ';\n';
}

// todo: This likely needs reoptimization.
// todo: perf problem with low max_block_num
function generate_nonstate({ table, index, limit_block_num, sort_keys, conditions, ...rest }) {
    generate_index({ table, index, sort_keys, conditions, ...rest });
    conditions = conditions || [];

    const fn_name = schema + '.' + rest['function'];
    const fn_args = prefix => sort_keys.map(x => `${prefix}${x.name} ${x.type},`).join('\n            ');
    const sort_keys_tuple = (prefix, suffix, sep) => sort_keys.map(x => `${prefix}${x.name}${suffix}`).join(sep);
    const sort_keys_tuple_expr = prefix => sort_keys.map(x => sort_key_expr(x, prefix, false)).join(',');

    const key_search = indent => `
        ${indent}for search in
        ${indent}    select
        ${indent}        *
        ${indent}    from
        ${indent}        ${schema}.${table}
        ${indent}    where
        ${indent}        (${sort_keys_tuple_expr('')}) >= (${sort_keys_tuple('"arg_first_', '"', ', ')})
        ${indent}        ${conditions.map(x => `and ${x}\n        ${indent}        `).join('')}
        ${indent}        ${limit_block_num ? `and ${table}.block_num <= max_block_num` : ``}
        ${indent}    order by
        ${indent}        ${sort_keys_tuple_expr('')}
        ${indent}    limit max_results
        ${indent}loop
        ${indent}    if (${sort_keys_tuple_expr('search.')}) > (${sort_keys_tuple('"arg_last_', '"', ', ')}) then
        ${indent}        return;
        ${indent}    end if;
        ${indent}    return next search;
        ${indent}end loop;
    `;

    functions += `
        drop function if exists ${fn_name};
        create function ${fn_name}(
            ${limit_block_num ? `max_block_num bigint,` : ``}
            ${fn_args('first_')}
            ${fn_args('last_')}
            max_results integer
        ) returns setof ${schema}.${table}
        as $$
            declare
                ${sort_keys.map(x => `arg_first_${x.name} ${x.type} = ${sort_key_arg_expr(x, 'first_')};`).join('\n                ')}
                ${sort_keys.map(x => `arg_last_${x.name} ${x.type} = ${sort_key_arg_expr(x, 'last_')};`).join('\n                ')}
                search record;
            begin
                ${key_search('        ')}
            end 
        $$ language plpgsql;
    `;
} // generate

function generate_state({ table, index, limit_block_num, args, keys, sort_keys, history_keys, ordered_fields, join, join_key_values, fields_from_join, ...rest }) {
    generate_index({ table, index, sort_keys, history_keys, ordered_fields, ...rest });

    const fn_name = schema + '.' + rest['function'];
    const fn_args = prefix => sort_keys.map(x => `${prefix}${x.name} ${x.type},`).join('\n            ');
    const sort_keys_tuple = (prefix, suffix, sep) => sort_keys.map(x => `${prefix}${x.name}${suffix}`).join(sep);
    const sort_keys_tuple_expr = sort_keys.map(x => sort_key_expr(x, `${table}.`, true)).join(',');

    let keys_by_name = {};
    for (let key of [...keys, ...history_keys])
        keys_by_name[key.name] = key;
    let data_fields = ordered_fields.filter(f => !(f.name in keys_by_name));
    let return_type = ordered_fields.map(f => '"' + f.name + '" ' + type_map[f.type]).join(', ') + fields_from_join.map(f => ', "' + f.new_name + '" ' + type_map[f.type]).join('');

    const non_joined = (compare, indent) => `
        ${indent}            ${ordered_fields.map(f => `"${f.name}" = block_search."${f.name}";`).join('\n                    ' + indent)}
        ${indent}            return next;
    `;

    const joined = (compare, indent) => `
        ${indent}            found_join_block = false;
        ${indent}            for join_block_search in
        ${indent}                select
        ${indent}                    ${fields_from_join.map(x => `${join}."${x.name}"`).join(',\n                            ' + indent)}
        ${indent}                from
        ${indent}                    ${schema}.${join}
        ${indent}                where
        ${indent}                    ${join_key_values.map(x => `${join}."${x.name}" = ${x.expression.replace('${table}', 'block_search')}`).join('\n                            ' + indent + 'and ')}
        ${indent}                    ${limit_block_num ? `and ${join}.block_num <= max_block_num` : ``}
        ${indent}                order by
        ${indent}                    ${join_key_values.map(x => `${join}."${x.name}"`).join(',\n                            ' + indent)},
        ${indent}                    ${history_keys.map(x => `${join}."${x.name + (x.desc ? '" desc' : '"')}`).join(',\n                            ' + indent)}
        ${indent}                limit 1
        ${indent}            loop
        ${indent}                if join_block_search.present then
        ${indent}                    found_join_block = true;
        ${indent}                    ${ordered_fields.map(f => `"${f.name}" = block_search."${f.name}";`).join('\n                            ' + indent)}
        ${indent}                    ${fields_from_join.map(f => `"${f.new_name}" = join_block_search."${f.name}";`).join('\n                            ' + indent)}
        ${indent}                    return next;
        ${indent}                end if;
        ${indent}            end loop;
        ${indent}            if not found_join_block then
        ${indent}                ${ordered_fields.map(f => `"${f.name}" = block_search."${f.name}";`).join('\n                        ' + indent)}
        ${indent}                ${fields_from_join.map(f => `"${f.new_name}" = ${empty_value_map[f.type] + '::' + type_map[f.type]};`).join('\n                        ' + indent)}
        ${indent}                return next;
        ${indent}            end if;
    `;

    const key_search = (compare, indent) => `
        ${indent}for key_search in
        ${indent}    select
        ${indent}        ${sort_keys_tuple_expr}
        ${indent}    from
        ${indent}        ${schema}.${table}
        ${indent}    where
        ${indent}        (${sort_keys_tuple(`${table}."`, '"', ', ')}) ${compare} (${sort_keys_tuple('"first_', '"', ', ')})
        ${indent}    order by
        ${indent}        ${sort_keys_tuple(`${table}."`, '"', ',\n                ' + indent)},
        ${indent}        ${history_keys.map(x => `${table}."${x.name + (x.desc ? '" desc' : '"')}`).join(',\n                ' + indent)}
        ${indent}    limit 1
        ${indent}loop
        ${indent}    if (${sort_keys_tuple('key_search."', '"', ', ')}) > (${sort_keys_tuple('last_', '', ', ')}) then
        ${indent}        return;
        ${indent}    end if;
        ${indent}    found_key = true;
        ${indent}    found_block = false;
        ${indent}    ${sort_keys.map(x => `first_${x.name} = key_search."${x.name}";`).join('\n            ' + indent)}
        ${indent}    for block_search in
        ${indent}        select
        ${indent}            *
        ${indent}        from
        ${indent}            ${schema}.${table}
        ${indent}        where
        ${indent}            ${sort_keys.map(x => `${table}."${x.name}" = key_search."${x.name}"`).join('\n                    ' + indent + 'and ')}
        ${indent}            ${limit_block_num ? `and ${table}.block_num <= max_block_num` : ``}
        ${indent}        order by
        ${indent}            ${sort_keys_tuple(`${table}."`, '"', ',\n                    ' + indent)},
        ${indent}            ${history_keys.map(x => `${table}."${x.name + (x.desc ? '" desc' : '"')}`).join(',\n                    ' + indent)}
        ${indent}        limit 1
        ${indent}    loop
        ${indent}        if block_search.present then
        ${indent}            ${join ? joined(compare, indent) : non_joined(compare, indent)}
        ${indent}        else
        ${indent}            "block_num" = block_search."block_num";
        ${indent}            "present" = false;
        ${indent}            ${keys.map(f => `"${f.name}" = key_search."${f.name}";`).join('\n                    ' + indent)}
        ${indent}            ${data_fields.map(f => `"${f.name}" = ${empty_value_map[f.type] + '::' + type_map[f.type]};`).join('\n                    ' + indent)}
        ${indent}            ${fields_from_join.map(f => `"${f.new_name}" = ${empty_value_map[f.type] + '::' + type_map[f.type]};`).join('\n                    ' + indent)}
        ${indent}            return next;
        ${indent}        end if;
        ${indent}        num_results = num_results + 1;
        ${indent}        found_block = true;
        ${indent}    end loop;
        ${indent}    if not found_block then
        ${indent}        "block_num" = 0;
        ${indent}        "present" = false;
        ${indent}        ${keys.map(f => `"${f.name}" = key_search."${f.name}";`).join('\n                ' + indent)}
        ${indent}        ${data_fields.map(f => `"${f.name}" = ${empty_value_map[f.type] + '::' + type_map[f.type]};`).join('\n                ' + indent)}
        ${indent}        ${fields_from_join.map(f => `"${f.new_name}" = ${empty_value_map[f.type] + '::' + type_map[f.type]};`).join('\n                ' + indent)}
        ${indent}        return next;
        ${indent}        num_results = num_results + 1;
        ${indent}    end if;
        ${indent}end loop;
    `;

    functions += `
        drop function if exists ${fn_name};
        create function ${fn_name}(
            ${limit_block_num ? `max_block_num bigint,` : ``}
            ${args.map(x => `"${x.name}" ${x.type},`).join('\n            ')}
            ${fn_args('first_')}
            ${fn_args('last_')}
            max_results integer
        ) returns table(${return_type})
        as $$
            declare
                key_search record;
                block_search record;
                join_block_search record;
                num_results integer = 0;
                found_key bool = false;
                found_block bool = false;
                found_join_block bool = false;
            begin
                if max_results <= 0 then
                    return;
                end if;
                ${key_search('>=', '        ')}
                loop
                    exit when not found_key or num_results >= max_results;
                    found_key = false;
                    ${key_search('>', '            ')}
                end loop;
            end 
        $$ language plpgsql;
    `;
} // generate_state

const config = JSON.parse(fs.readFileSync('../src/query-config.json', 'utf8'));
const tables = {};
for (let table of config.tables) {
    const fields = {};
    for (let field of table.fields)
        fields[field.name] = field;
    tables[table.name] = { fields, ordered_fields: table.fields, keys: table.keys, history_keys: table.history_keys };
}

function get_type(type) {
    return type_map[type] || type;
}

function fill_types(query, fields) {
    for (let field of fields)
        if (field.type)
            field.type = get_type(field.type);
        else
            field.type = get_type(tables[query.table].fields[field.name].type);
}

for (let query of config.queries) {
    query = {
        ...query,
        args: query.args || [],
        keys: tables[query.table].keys || [],
        sort_keys: query.sort_keys || [],
        history_keys: tables[query.table].history_keys || [],
        ordered_fields: tables[query.table].ordered_fields,
        join_key_values: (query.join_key_values || []).map(({ name, expression }) => ({ name, expression, type: tables[query.join].fields[name].type })),
        fields_from_join: (query.fields_from_join || []).map(({ name, new_name }) => ({ name, new_name, type: tables[query.join].fields[name].type })),
    };
    fill_types(query, query.args);
    fill_types(query, query.keys);
    fill_types(query, query.sort_keys);
    fill_types(query, query.history_keys);
    if (query.is_state)
        generate_state(query);
    else
        generate_nonstate(query);
}

console.log(header);
console.log(indexes);
console.log(functions);
