-- 01 · INVENTARIO DE LAS FOTOS INCRUSTADAS (SOLO LECTURA)
-- No modifica nada ni muestra las imágenes: solo tamaños, formato y huellas (MD5 y SHA-256) de los bytes
-- decodificados. Guarda el resultado: es la referencia para comprobar la integridad después de migrar.
-- Ejecútalo en el SQL Editor de Supabase. No forma parte de supabase/migrations.

select
  u.id                                                                      as user_id,
  length(u.raw_user_meta_data->>'avatar_data')                              as caracteres_data_url,
  substring(u.raw_user_meta_data->>'avatar_data' from '^data:([^;,]+)')     as tipo_declarado,
  (u.raw_user_meta_data->>'avatar_data') ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
                                                                            as formato_migrable,
  octet_length(decode(split_part(u.raw_user_meta_data->>'avatar_data', ',', 2), 'base64')) as bytes,
  md5(decode(split_part(u.raw_user_meta_data->>'avatar_data', ',', 2), 'base64'))          as md5,
  encode(sha256(decode(split_part(u.raw_user_meta_data->>'avatar_data', ',', 2), 'base64')), 'hex') as sha256,
  length(u.raw_user_meta_data::text)                                        as caracteres_user_metadata,
  u.raw_user_meta_data ? 'avatar_path'                                      as ya_tiene_avatar_path
from auth.users u
where u.raw_user_meta_data ? 'avatar_data'
order by u.created_at;

-- Esperado ahora: 2 filas, formato_migrable = true y ya_tiene_avatar_path = false.
-- Si alguna fila tiene formato_migrable = false, la aplicación no la migrará (la conserva intacta):
-- coméntalo antes de continuar.
-- Si decode() falla con «invalid base64», hay un data URL dañado: detente y revísalo.
