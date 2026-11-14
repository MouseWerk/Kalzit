//! A report's CSV files: one per table result (frame) of each panel, written like a CSV export
//! (`analysis::export::csv`: semicolons, decimal commas and a byte order mark in German, commas
//! and points in English; cells that could start a formula are defused). Documents and graphs are
//! no tables: a panel shows them as a table only through an explicit projection step, else it is
//! left out of the CSV files with the reason. Several files go in one zip file.

use std::collections::BTreeSet;
use std::io::Write as _;

use super::gather::{Content, Gathered};
use super::model::ReportLanguage;
use crate::analysis::export;
use crate::shapes::ExportLanguage;

pub struct File {
    pub name: String,
    pub data: Vec<u8>,
}

/// A panel left out of the CSV files, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeftOut {
    pub panel: String,
    pub code: &'static str,
}

/// The CSV files of `g`, and the panels left out.
pub fn files(g: &Gathered, lang: ReportLanguage) -> (Vec<File>, Vec<LeftOut>) {
    let language = match lang {
        ReportLanguage::De => ExportLanguage::De,
        ReportLanguage::En => ExportLanguage::En,
    };
    let mut out = Vec::new();
    let mut left_out = Vec::new();
    let mut names = BTreeSet::new();
    for panel in &g.panels {
        let title = if panel.title.trim().is_empty() { panel.id.clone() } else { panel.title.clone() };
        let Content::Results(results) = &panel.content else {
            // Text panels hold no table; a panel that could not run fails the whole run first.
            continue;
        };
        if results.frames.is_empty() {
            if !results.documents.is_empty() || !results.graphs.is_empty() {
                left_out.push(LeftOut { panel: title, code: "reports.csv_needs_projection" });
            }
            continue;
        }
        let several = results.frames.len() > 1;
        for f in &results.frames {
            let base = if several { format!("{title} {}", f.name) } else { title.clone() };
            let mut name = export::file_name(&base, "csv");
            let mut n = 2;
            while !names.insert(name.clone()) {
                name = export::file_name(&format!("{base} {n}"), "csv");
                n += 1;
            }
            out.push(File { name, data: export::csv(&f.frame, language) });
        }
    }
    (out, left_out)
}

/// The files as one zip file.
pub fn zip(files: &[File]) -> Result<Vec<u8>, String> {
    use zip::write::SimpleFileOptions;
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for f in files {
        out.start_file(f.name.as_str(), options).map_err(|e| format!("the zip file: {e}"))?;
        out.write_all(&f.data).map_err(|e| format!("the zip file: {e}"))?;
    }
    Ok(out.finish().map_err(|e| format!("the zip file: {e}"))?.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::steps::NamedFrame;
    use crate::reports::gather::{PanelOut, Results};
    use crate::shapes::{DocumentSet, Field, FieldType, Frame, TimeRange};
    use serde_json::{Value, json};

    fn frame() -> Frame {
        Frame::new(vec![
            Field {
                name: "Region".into(),
                field_type: FieldType::String,
                unit: None,
                values: vec![json!("Nord"), json!("=SUM(A1)")],
                labels: None,
            },
            Field {
                name: "Umsatz".into(),
                field_type: FieldType::Number,
                unit: None,
                values: vec![json!(1234.5), json!(null)],
                labels: None,
            },
        ])
        .unwrap()
    }

    fn panel(id: &str, title: &str, content: Content) -> PanelOut {
        PanelOut { id: id.into(), title: title.into(), kind: "table".into(), options: Value::Null, unit: None, content }
    }

    fn gathered(panels: Vec<PanelOut>) -> Gathered {
        Gathered {
            dashboard_title: "Lager".into(),
            range: TimeRange { from: 0, to: 1 },
            zone: chrono_tz::UTC,
            variables: Default::default(),
            panels,
        }
    }

    #[test]
    fn one_file_per_table_documents_left_out_with_the_reason() {
        let docs = DocumentSet {
            documents: vec![json!({ "a": 1 }).into()],
            schema: vec![],
            next_cursor: None,
            truncated: None,
            notices: vec![],
            executed_query: None,
            distributable: false,
        };
        let g = gathered(vec![
            panel(
                "p1",
                "Umsatz je Region",
                Content::Results(Results {
                    frames: vec![NamedFrame { name: "A".into(), frame: frame() }],
                    ..Default::default()
                }),
            ),
            panel(
                "p2",
                "Umsatz je Region",
                Content::Results(Results {
                    frames: vec![NamedFrame { name: "A".into(), frame: frame() }],
                    ..Default::default()
                }),
            ),
            panel(
                "p3",
                "Bestellungen",
                Content::Results(Results { documents: vec![("A".into(), docs)], ..Default::default() }),
            ),
            panel("p4", "Notiz", Content::Text("Hallo".into())),
        ]);
        let (files, left_out) = files(&g, ReportLanguage::En);
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Umsatz-je-Region.csv", "Umsatz-je-Region-2.csv"]);
        let text = String::from_utf8(files[0].data.clone()).unwrap();
        assert_eq!(text, "\u{feff}Region,Umsatz\r\nNord,1234.5\r\n'=SUM(A1),\r\n");
        assert_eq!(left_out, [LeftOut { panel: "Bestellungen".into(), code: "reports.csv_needs_projection" }]);
        let de = super::files(&g, ReportLanguage::De).0;
        let text = String::from_utf8(de[0].data.clone()).unwrap();
        assert!(text.starts_with('\u{feff}') && text.contains("Nord;1234,5"), "{text}");
    }

    #[test]
    fn several_files_go_in_a_zip() {
        let files = vec![
            File { name: "a.csv".into(), data: b"x\r\n".to_vec() },
            File { name: "b.csv".into(), data: b"y\r\n".to_vec() },
        ];
        let bytes = zip(&files).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(archive.len(), 2);
        let mut content = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("b.csv").unwrap(), &mut content).unwrap();
        assert_eq!(content, "y\r\n");
    }
}
