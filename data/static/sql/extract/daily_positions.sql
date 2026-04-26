-- DAILY_POSITIONS.sql
select
'POSITION' as type,
app_id,
uid,
uid_version,
account,
$business_date as as_of_date
from sample_positions