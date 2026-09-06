"""
Generate the BSA-1 reference table at 60 significant digits.

The table is the arbitration point for the arithmetic: the TypeScript engine, the Solidity
adjudicator and any third-party implementation are all checked against these values. It is
produced with Python's decimal module at 60 digits, which is far above the 27-digit working
scale, so the residual in the table is not what the tolerance measures.
"""
import json
from decimal import Decimal, getcontext

getcontext().prec = 60
RAY = Decimal(10) ** 27


def ray(x: Decimal) -> str:
    return str(int((x * RAY).to_integral_value(rounding="ROUND_HALF_EVEN")))


def dln(x: Decimal) -> Decimal:
    return x.ln()


def dexp(x: Decimal) -> Decimal:
    return x.exp()


ln_inputs = [
    "0.000001", "0.001", "0.01", "0.1", "0.3333333333", "0.5", "0.9", "0.99", "0.999999",
    "1", "1.000001", "1.5", "2", "2.718281828459045", "3", "7", "10", "100", "1000",
    "100000", "100000000", "1000000000000",
]
exp_inputs = [
    "-80", "-30", "-10", "-5", "-1", "-0.5", "-0.1", "-0.000001", "0",
    "0.000001", "0.1", "0.5", "1", "5", "10", "30", "80",
]
pow_inputs = [
    ("0.01", "-0.5"), ("0.05", "-0.5"), ("0.2", "-0.5"), ("0.5", "-0.5"), ("1", "-0.5"),
    ("0.01", "-0.75"), ("0.25", "-0.25"), ("0.009900990099", "-0.5"),
    ("2", "10"), ("1.5", "3"), ("0.5", "0.5"),
]

table = {
    "spec": "BSA-1|scale=1e27|round=trunc-toward-zero|ln=atanh-10-tab16|exp=taylor-25",
    "scale": "1e27",
    "ln": [{"x": ray(Decimal(s)), "y": ray(dln(Decimal(s)))} for s in ln_inputs],
    "exp": [{"x": ray(Decimal(s)), "y": ray(dexp(Decimal(s)))} for s in exp_inputs],
    "pow": [
        {"x": ray(Decimal(a)), "y": ray(Decimal(b)), "z": ray(dexp(Decimal(b) * dln(Decimal(a))))}
        for a, b in pow_inputs
    ],
    "constants": {
        "LN2": ray(Decimal(2).ln()),
        "LN10": ray(Decimal(10).ln()),
    },
}

with open("vectors/bsa1-reference.json", "w", encoding="utf-8") as f:
    json.dump(table, f, indent=2)
print(f"ln={len(table['ln'])} exp={len(table['exp'])} pow={len(table['pow'])}")
