"""The products pulled from QH, their QH codes and expiry rules.

QH codes are the root plus month code and two-digit year: CLZ26, COF27, WTCLCOZ26. WTCLCO (WTI minus Brent,
"CLBZZ" on the desk) is listed on ICE and expires with Brent: QH gives WTCLCOZ26 the Brent Dec-26 expiry.
"""

from dataclasses import dataclass

from app.quant.calendar import key_code


@dataclass(frozen=True)
class QhProduct:
    root: str
    label: str
    # Expiry rule in app.quant.calendar.rule_expiry.
    rule: str


PRODUCTS: dict[str, QhProduct] = {
    p.root: p for p in (QhProduct("CL", "WTI", "cl"), QhProduct("CO", "Brent", "brent"), QhProduct("WTCLCO", "CLBZZ", "brent"))
}


def contract_code(root: str, key: int) -> str:
    """QH code of the contract delivering in month ordinal `key` ('CLZ26')."""
    return f"{root}{key_code(key)}"
