# Auditor v2 flags on the BIRD dev answer key: hand verdicts

Recorded 2026-11-07. Gold set: BIRD dev 2025-11-06 release (`~/data/bird_dev_20251106/data/dev_20251106-00000-of-00001.json`), databases from `dev_20240627`. This is the set `auditor_v2/survey2.py` audited (380 JOIN+aggregate gold queries).
Every gold and corrected value below was produced by executing SQL on the read-only SQLite files (`akv/verify.py`, `akv/build.py`). Verdicts and reasons are hand-written after reading the question, evidence, gold SQL and auditor finding.

Verdicts: TRUE_BUG = the question asks for a per-entity count/sum/avg and the fan-out changes the answer. INTENDED = the question counts the joined rows, so repeats are correct. FALSE_ALARM = rows repeat but the answer is unaffected, or the auditor's reasoning is wrong. UNCLEAR = wording ambiguous enough that reasonable people could disagree.

## Counts: v2, 5 s timeout (37 flags)

| verdict | n |
|---|---|
| TRUE_BUG | 31 |
| INTENDED | 1 |
| UNCLEAR | 2 |
| FALSE_ALARM | 3 |

- Strict precision = TRUE_BUG / 37 = 31/37 = 83.8%
- Lenient precision = (TRUE_BUG + INTENDED + UNCLEAR) / 37 = everything not a FALSE_ALARM = 34/37 = 91.9%
- For comparison with the deck's 86%: (TRUE_BUG + INTENDED) / 37 = 32/37 = 86.5%; (TRUE_BUG + UNCLEAR) / 37 = 33/37 = 89.2%

## Counts: v2_15s, 15 s timeout (37 flags; 127 replaces 207)

| verdict | n |
|---|---|
| TRUE_BUG | 31 |
| INTENDED | 1 |
| UNCLEAR | 2 |
| FALSE_ALARM | 3 |

- Strict precision = TRUE_BUG / 37 = 31/37 = 83.8%
- Lenient precision = (TRUE_BUG + INTENDED + UNCLEAR) / 37 = everything not a FALSE_ALARM = 34/37 = 91.9%
- For comparison with the deck's 86%: (TRUE_BUG + INTENDED) / 37 = 32/37 = 86.5%; (TRUE_BUG + UNCLEAR) / 37 = 33/37 = 89.2%

## Deck claim check

Deck: 30 TRUE_BUG, 2 FALSE_ALARM, 3 UNCLEAR, 2 INTENDED (81% strict / 86% lenient). This record: 31 TRUE_BUG, 3 FALSE_ALARM, 2 UNCLEAR, 1 INTENDED. "30 real bugs" is an undercount by 1 under these calls; the breakdown of the other 7 differs. The 207/127 swap does not change any count (both are FALSE_ALARM).

## Per flag

| q | db | verdict | gold | corrected | reason | 2024 dev.json |
|---|---|---|---|---|---|---|
| 96 | financial | TRUE_BUG | 9,704,980.17 | 48,653.74 | loan and trans are both LEFT JOINed to the account, so each loan amount is summed once per transaction; avg_loan_amount for M/Senior/central Bohemia 9,704,980.17 vs 48,653.74 when loans and transactions are aggregated separately; 24 of 30 rows change. | not present (new/reworded in 2025) |
| 127 (v2_15s only) | financial | FALSE_ALARM | 4167 rows (avg_client_age; first row 43.9) | identical to gold (4167 rows) | Timeout-dependent (flagged only by v2_15s). Clients repeat by #orders, uniformly within each account, so AVG(age) is unchanged: all 4,167 rows identical to a per-account AVG over distinct clients. | not present (new/reworded in 2025) |
| 140 | financial | TRUE_BUG | 36,200,426 / 32,012,787 | 31,522,862 / 27,931,632 | trans is LEFT JOINed with disp/card, so accounts with 2 dispositions have their transactions summed twice; total deposits / withdrawals 36,200,426 / 32,012,787 vs 31,522,862 / 27,931,632 (equal to a direct SUM over Pisek transactions). | not present (new/reworded in 2025) |
| 150 | financial | TRUE_BUG | 2,260 | 55 | Asks how many accounts; gold counts transactions (2,260, while North Bohemia has only 457 accounts); distinct accounts = 55. | same gold |
| 154 | financial | TRUE_BUG | 8,645 / 787 / 229,686,859 | 14 / 2 / 193,957,096 | loan x disp x card x trans per account; Senior good loans / bad loans / income 8,645 / 787 / 229,686,859 vs 14 / 2 / 193,957,096 (the whole DB has 203 status-A loans). | not present (new/reworded in 2025) |
| 197 | toxicology | TRUE_BUG | 116.6527 | 3.3537 | Each oxygen atom is counted once per single bond in its molecule; average oxygen atoms per single-bonded molecule 116.65 vs 3.354. | same gold |
| 198 | toxicology | TRUE_BUG | 732.125 | 20.25 | Wording is murky, but the gold's own structure counts single bonds per carcinogenic molecule and the atom join multiplies that count; gold 732.125 equals AVG(#single bonds x #atoms) exactly; per-molecule single bonds 20.25 (0.834 under the evidence ratio). No reading gives 732.125. | same gold |
| 200 | toxicology | TRUE_BUG | TR041 / 14 / 14 / 112 / 28 / 28 / 0 / 4 / Multiple Triple Bonds / TR499 / 4 / 3 / 0 / 0 / 4 / 0 / 0 / Multiple Triple Bonds | TR041 / 14 / 14 / 8 / 2 / 2 / 0 / 4 / Multiple Triple Bonds / TR499 / 4 / 3 / 0 / 0 / 1 / 0 / 0 / Single Triple Bond | atom x bond cross product; TR041 carbon / nitrogen / triple bonds 112 / 28 / 28 vs 8 / 2 / 2 (TR041 has 14 atoms); TR499 has 1 triple bond, gold labels it 'Multiple Triple Bonds'. | not present (new/reworded in 2025) |
| 204 | toxicology | TRUE_BUG | 279.1379 / 106.8621 | 8.7931 / 3.5517 | atom x bond cross product; avg carbon atoms / avg double bonds per carcinogenic molecule 279.14 / 106.86 vs 8.79 / 3.55. | not present (new/reworded in 2025) |
| 205 | toxicology | TRUE_BUG | TR059 / 4,494 / 428 / 1,122 | TR059 / 42 / 4 / 11 | atom x bond cross product; TR059 carbon / chlorine / double bonds 4,494 / 428 / 1,122 vs 42 / 4 / 11; all 340 rows change and the carbon ranking reorders. | not present (new/reworded in 2025) |
| 207 (v2 (5 s) only) | toxicology | FALSE_ALARM | 5 rows | identical to gold (5 rows) | Timeout-dependent (flagged only by v2 at 5 s). The inflated double_bonds_count is used only in HAVING > 0; result identical after de-duplication (5 rows). | not present (new/reworded in 2025) |
| 269 | toxicology | TRUE_BUG | 12 | 6 bonds touching iodine (4 distinct bonds on the gold path) | 3 iodine atoms x 4 bonds in TR110 gives 12; bonds touching an iodine atom = 6 (connected table; TR110 and TR340, but TR340 is missing from the molecule table so the gold path drops it); distinct bonds on the gold path = 4. 12 is wrong under every reading. | same gold |
| 298 | toxicology | UNCLEAR | 17.2209 | 41.98 of all molecules / 94.74 of carcinogenic molecules | Garbled wording ('percentage of molecules containing carcinogenic compounds that element is hydrogen'). Gold 17.22 = H atoms in carcinogenic molecules / all atoms. Counting molecules gives 41.98 (of all molecules) or 94.74 (of carcinogenic ones); an atom-level reading is not impossible, so left UNCLEAR. | same gold |
| 330 | toxicology | TRUE_BUG | 100 | 50 | Molecules with an H atom and a triple bond: TR377 (-) and TR499 (+), so 50%; gold's numerator counts TR499's 2 joined rows over 2 distinct molecules and returns 100. | same gold |
| 363 | card_games | TRUE_BUG | 205 | 189 | Asks how many cards; gold counts legality rows: 205 vs 189 distinct cards. | different gold |
| 386 | card_games | TRUE_BUG | 582 | 93 | Asks how many legal cards; gold counts legality rows: 582 vs 93 distinct cards. | not present (new/reworded in 2025) |
| 520 | card_games | FALSE_ALARM | Anna Pavleeva / gladiator | tie: 190 artists with 1 card (Anna Pavleeva among them); auditor rewrite returns [(None, 'commander')] | Minimum is 1 card per artist with 190 artists tied (83 that have legalities); gold's Anna Pavleeva has 1 card, so she is a valid least-illustrator; the fan-out only changes tie-breaking. The auditor's rewrite returns a NULL artist, which is worse. (Gold separately lists only 1 of her 2 formats, a GROUP BY bug, not fan-out.) | same gold |
| 672 | codebase_community | TRUE_BUG | 19 | 14 (18 if SUM per user) | Asks how many users; gold counts posts: 19 vs 14 distinct users (18 if 'total favorite amount' means SUM per user). Either reading differs from 19. | same gold |
| 677 | codebase_community | FALSE_ALARM | 3 | 3 (auditor rewrite: 1) | Asks how many posts; one user is named Jay Stevens and has 3 posts in 2010, so gold 3 is correct; the auditor's COUNT(DISTINCT user) rewrite (1) is wrong. | same gold |
| 1148 | european_football_2 | UNCLEAR | 40.6575 | 51.16 any>70 / 34.43 latest / 29.96 avg (per player) | Asks for a percentage of players, but gold 40.66 is the share of Player_Attributes records; per player it is 51.16 (any rating > 70), 34.43 (latest), 29.96 (average). The evidence formula can be read at record level and the per-player rule is unspecified, so left UNCLEAR. | same gold |
| 1167 | thrombosis_prediction | TRUE_BUG | 7.5833 | 5.4167 (auditor rewrite: 0.8333) | Asks how many male patients were tested per month; gold counts lab tests (91 tests / 12 = 7.58); counting distinct patients in each month gives 65 / 12 = 5.42. Note the auditor's own rewrite (10 distinct patients / 12 = 0.83) is also wrong. | same gold |
| 1174 | thrombosis_prediction | TRUE_BUG | 47.6522 | 48.3077 | Average age of patients; gold averages over 46 lab rows from 26 patients: 47.652 vs 48.308. | same gold |
| 1203 | thrombosis_prediction | TRUE_BUG | 641 | 88 | Asks how many patients; gold counts lab rows: 641 vs 88. | same gold |
| 1223 | thrombosis_prediction | TRUE_BUG | True | False (7 male vs 7 female patients; 320 vs 41 lab rows) | Answer flips: counting lab rows males lead 320 vs 41 (True), counting patients it is 7 vs 7, so 'more male than female' is False. | same gold |
| 1227 | thrombosis_prediction | TRUE_BUG | 74.6854 | 71.95 | Average age of male patients; gold averages over 321 lab rows from 20 patients: 74.685 vs 71.95 (both use date('now'); values computed 2026-11-07). | same gold |
| 1245 | thrombosis_prediction | INTENDED | 51 | 51 (auditor rewrite: 12 patients) | Asks how many examinations (lab tests); the 51 joined rows are 51 distinct (ID, Date) lab records, so gold 51 is right; the auditor's 12 counts patients instead. | same gold |
| 1252 | thrombosis_prediction | TRUE_BUG | 4 | 1 | Asks how many patients; gold counts lab x exam rows: 4 vs 1. | same gold |
| 1255 | thrombosis_prediction | TRUE_BUG | RA | SLE | Most common diagnosis among patients: counting patients SLE 9 vs RA 6 (SLE 10 with the evidence's inclusive bounds); gold's RA comes from counting lab rows (RA 36 rows vs SLE 29). | same gold |
| 1267 | thrombosis_prediction | TRUE_BUG | 7 | 6 | Asks how many patients; one patient (5440870) appears twice: 7 vs 6. | same gold |
| 1279 | thrombosis_prediction | TRUE_BUG | 39.3715 | 39.726 | Percentage of patients; gold divides lab rows: 39.3715 vs 39.7260 (29 of 73 patients). Small, but a different answer. | different gold |
| 1280 | thrombosis_prediction | TRUE_BUG | 1,924 | 45 | Asks how many male patients; gold 1,924 counts lab rows (the DB has only 202 male patients); distinct = 45. | same gold |
| 1291 | thrombosis_prediction | TRUE_BUG | 1,696 | 46 | Asks how many male patients; gold counts lab rows: 1,696 vs 46. | same gold |
| 1295 | thrombosis_prediction | TRUE_BUG | 4 | 1 | Asks how many patients; gold counts lab x exam rows: 4 vs 1. | same gold |
| 1297 | thrombosis_prediction | TRUE_BUG | 14 | 2 | Asks how many patients; gold counts lab x exam rows: 14 vs 2. | same gold |
| 1302 | thrombosis_prediction | TRUE_BUG | 7 | 1 | Asks how many patients; gold counts lab x exam rows: 7 vs 1. | same gold |
| 1305 | thrombosis_prediction | TRUE_BUG | 3,688 | 115 | Asks how many patients; gold 3,688 counts lab rows (only 488 admitted patients exist); distinct = 115. | same gold |
| 1306 | thrombosis_prediction | TRUE_BUG | 2,044 | 54 | Asks how many patients; gold 2,044 counts lab rows (only 195 SLE patients exist); distinct = 54. | same gold |
| 1308 | thrombosis_prediction | TRUE_BUG | 10,079 | 294 | Asks how many patients; gold 10,079 counts lab rows (the DB has 1,238 patients); distinct = 294. | same gold |

## Release notes

- The audited gold is already the 2025-11-06 release, so the useful comparison is backwards to `dev_20240627/dev.json` (same question text) and Mini-Dev (`mini_dev_sqlite.json`).
- q363: 2024 gold SELECT COUNT(DISTINCT T1.id) FROM cards AS T1 INNER JOIN legalities AS T2 ON T1.uuid = T2.uuid WHERE T2.status = 'Restricted' AND T1.isStarter = 1
- q1279: 2024 gold SELECT COUNT(CASE WHEN T1.Diagnosis LIKE '%SLE%' THEN T1.ID ELSE 0 END) / COUNT(T1.ID) FROM Patient AS T1 INNER JOIN Laboratory AS T2 ON T1.ID = T2.ID WHERE T2.`GOT` >= 60
- Present in Mini-Dev with the same question text: [197, 198, 672, 1148, 1227, 1252, 1255, 1267, 1302]. q197: same gold SQL; q198: same gold SQL; q672: same gold SQL; q1148: different gold SQL: SELECT CAST(COUNT(CASE WHEN t2.overall_rating > 70 AND t1.height < 180 THEN t1.id ELSE NULL END) AS REAL) * 100 / COUNT(t1.id) percent FROM Player AS t1 INNER JOIN Player_Attribute; q1227: same gold SQL; q1252: same gold SQL; q1255: same gold SQL; q1267: same gold SQL; q1302: same gold SQL
- Reading: q363's 2024 gold used COUNT(DISTINCT), so the 2025 release introduced that bug. q1279's 2024 gold was wrong differently (ELSE 0 makes COUNT count every row, and integer division). No flagged bug was fixed by the 2025 release relative to 2024; 8 flags (96, 127, 140, 154, 200, 204, 205, 207) are questions new in 2025.
- q386: the 2024 file has a differently worded q386 (count plus legality status, no status filter) whose gold is also COUNT(T1.id) over cards x legalities.
