use std::future::Future;

use crate::evidence::{Evidence, StepReport};

pub const MAX_REPAIR_PASSES: usize = 2;

pub async fn verify_with_repair<C, CF, R, RF>(
    step_id: impl Into<String>,
    claim_boundary: impl Into<String>,
    mut check: C,
    mut repair: R,
) -> (StepReport, usize)
where
    C: FnMut() -> CF,
    CF: Future<Output = Vec<Evidence>>,
    R: FnMut(Vec<Evidence>) -> RF,
    RF: Future<Output = ()>,
{
    let mut report = StepReport::new(step_id, claim_boundary);
    let _ = report.prepare();
    for passes in 0..=MAX_REPAIR_PASSES {
        let evidence = check().await;
        if report.verify(evidence.clone()).is_ok() {
            return (report, passes);
        }
        if passes < MAX_REPAIR_PASSES {
            repair(evidence).await;
        }
    }
    report.exhausted();
    (report, MAX_REPAIR_PASSES)
}
