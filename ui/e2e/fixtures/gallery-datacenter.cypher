// The graph of the gallery renders (ui/e2e/gallery/gallery.shots.ts), seeded into Neo4j by
// `.github/scripts/e2e-services.sh seed-gallery` in the gallery workflow only: it replaces the
// shop graph of the graph spec, so it never runs before the e2e tests. A fictional data center,
// "Site Basalt": three halls of two rows with two racks each and two servers per rack; a leaf
// switch on top of every rack, two spines per hall and two core switches; two UPS per hall feed
// an A and a B PDU per row, and two cooling units per hall cool its rows. Names, vendors and
// figures are invented. Plain Cypher, one statement per `;`; it starts by deleting everything,
// so a retry seeds the same graph.
MATCH (n) DETACH DELETE n;
CREATE (:Site {name: 'Site Basalt', operator: 'Sunstone Hosting', tier: 'III'});
UNWIND ['A', 'B', 'C'] AS code
MATCH (site:Site)
CREATE (site)-[:CONTAINS]->(:Hall {name: 'Hall ' + code, code: code, areaM2: 640});
UNWIND [1, 2] AS number
MATCH (hall:Hall)
CREATE (hall)-[:CONTAINS]->(:Row {name: 'Row ' + hall.code + number, code: hall.code + number, hall: hall.code});
UNWIND [1, 2] AS number
MATCH (row:Row)
CREATE (row)-[:CONTAINS]->(:Rack {name: 'Rack ' + row.code + '-0' + number, code: row.code + '-0' + number, hall: row.hall, units: 42, maxKw: 14});
UNWIND [1, 2] AS slot
MATCH (rack:Rack)
CREATE (rack)-[:CONTAINS]->(:Server {
  name: 'srv-' + toLower(rack.code) + '-' + slot,
  role: CASE slot WHEN 1 THEN 'compute' ELSE CASE rack.hall WHEN 'C' THEN 'storage' ELSE 'database' END END,
  vendor: CASE rack.hall WHEN 'A' THEN 'Kestrel Systems' WHEN 'B' THEN 'Orvane' ELSE 'Tessaline' END,
  model: CASE slot WHEN 1 THEN 'KX-2400' ELSE 'SR-880' END,
  cores: CASE slot WHEN 1 THEN 128 ELSE 64 END,
  memoryGb: CASE slot WHEN 1 THEN 1024 ELSE 512 END,
  bmcFirmware: CASE rack.hall WHEN 'A' THEN '4.12.2' WHEN 'B' THEN '4.11.0' ELSE '4.12.2' END,
  unit: slot * 18,
  status: 'in service'
});
CREATE (:Switch {name: 'core-1', tier: 'core', model: 'NX-9600', ports: 64, speedGbps: 400}),
  (:Switch {name: 'core-2', tier: 'core', model: 'NX-9600', ports: 64, speedGbps: 400});
UNWIND [1, 2] AS number
MATCH (hall:Hall)
CREATE (:Switch {name: 'spine-' + toLower(hall.code) + number, tier: 'spine', hall: hall.code, model: 'NX-7300', ports: 32, speedGbps: 400});
MATCH (spine:Switch {tier: 'spine'}), (core:Switch {tier: 'core'})
CREATE (spine)-[:UPLINK {speedGbps: 400}]->(core);
MATCH (rack:Rack)
CREATE (:Switch {name: 'leaf-' + toLower(rack.code), tier: 'leaf', hall: rack.hall, model: 'NX-3100', ports: 48, speedGbps: 100})-[:MOUNTED_IN]->(rack);
MATCH (leaf:Switch {tier: 'leaf'}), (spine:Switch {tier: 'spine'})
WHERE leaf.hall = spine.hall
CREATE (leaf)-[:UPLINK {speedGbps: 100}]->(spine);
MATCH (rack:Rack)-[:CONTAINS]->(server:Server), (leaf:Switch {tier: 'leaf'})-[:MOUNTED_IN]->(rack)
CREATE (server)-[:LINK {speedGbps: 25}]->(leaf);
CREATE (:Utility {name: 'Grid feed 20 kV', supplier: 'Basalt Grid'}),
  (:Generator {name: 'Generator G1', fuel: 'diesel', capacityKw: 2000});
UNWIND [1, 2] AS number
MATCH (hall:Hall), (grid:Utility), (generator:Generator)
CREATE (ups:UPS {name: 'UPS ' + hall.code + number, hall: hall.code, capacityKw: 400, autonomyMin: 12})
CREATE (grid)-[:FEEDS]->(ups)
CREATE (generator)-[:BACKS_UP]->(ups);
UNWIND ['A', 'B'] AS side
MATCH (row:Row), (ups:UPS {hall: row.hall})
WHERE ups.name = 'UPS ' + row.hall + CASE side WHEN 'A' THEN '1' ELSE '2' END
CREATE (ups)-[:FEEDS]->(pdu:PDU {name: 'PDU ' + row.code + '-' + side, side: side, hall: row.hall, ratedKw: 22});
MATCH (row:Row)-[:CONTAINS]->(rack:Rack), (pdu:PDU)
WHERE pdu.name STARTS WITH 'PDU ' + row.code + '-'
CREATE (pdu)-[:FEEDS]->(rack);
UNWIND [1, 2] AS number
MATCH (hall:Hall)
CREATE (:Cooling {name: 'CRAH ' + hall.code + number, hall: hall.code, capacityKw: 180, supplyC: 22});
MATCH (cooling:Cooling), (row:Row)
WHERE cooling.hall = row.hall
CREATE (cooling)-[:COOLS]->(row);
