-- daily_marker.sql
select
'TRADE' as type,
app_id,
uid,
uid_version,
account,
20260424 as as_of_date
from dt
union
select
'POSITION' as type,
app_id,
uid,
uid_version,
account,
20260424 as as_of_date
from dp