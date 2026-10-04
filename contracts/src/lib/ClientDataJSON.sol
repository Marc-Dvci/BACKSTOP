// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Parses the flat client-data object emitted by the supported browsers. Required
/// fields must occur once at the top level; nested objects, escapes and malformed JSON fail
/// closed. Unknown flat string/boolean fields are allowed for browser extensions.
library ClientDataJSON {
    function matches(bytes memory data, string memory origin, string memory challenge) internal pure returns (bool) {
        uint256 i = whitespace(data, 0);
        if (i >= data.length || data[i++] != "{") return false;
        uint256 seen;
        while (true) {
            i = whitespace(data, i);
            (bool keyOk, bytes32 key, uint256 afterKey) = readString(data, i);
            if (!keyOk) return false;
            i = whitespace(data, afterKey);
            if (i >= data.length || data[i++] != ":") return false;
            i = whitespace(data, i);
            bool stringValue = i < data.length && data[i] == '"';
            bytes32 value;
            if (stringValue) {
                (bool valueOk, bytes32 parsed, uint256 afterValue) = readString(data, i);
                if (!valueOk) return false;
                value = parsed;
                i = afterValue;
            } else if (literal(data, i, "false")) {
                value = keccak256("false"); i += 5;
            } else if (literal(data, i, "true")) {
                value = keccak256("true"); i += 4;
            } else return false;

            uint256 bit;
            if (key == keccak256("type")) {
                bit = 1;
                if (!stringValue || value != keccak256("webauthn.get")) return false;
            } else if (key == keccak256("origin")) {
                bit = 2;
                if (!stringValue || value != keccak256(bytes(origin))) return false;
            } else if (key == keccak256("challenge")) {
                bit = 4;
                if (!stringValue || value != keccak256(bytes(challenge))) return false;
            } else if (key == keccak256("crossOrigin")) {
                bit = 8;
                if (stringValue || value != keccak256("false")) return false;
            }
            if (bit != 0 && seen & bit != 0) return false;
            seen |= bit;
            i = whitespace(data, i);
            if (i >= data.length) return false;
            if (data[i] == "}") return seen & 7 == 7 && whitespace(data, i + 1) == data.length;
            if (data[i++] != ",") return false;
        }
        return false;
    }

    function whitespace(bytes memory data, uint256 i) private pure returns (uint256) {
        while (i < data.length && (data[i] == " " || data[i] == 0x09 || data[i] == 0x0a || data[i] == 0x0d)) i++;
        return i;
    }

    function readString(bytes memory data, uint256 i) private pure returns (bool, bytes32, uint256) {
        if (i >= data.length || data[i++] != '"') return (false, bytes32(0), i);
        uint256 start = i;
        while (i < data.length && data[i] != '"') {
            if (data[i] == 0x5c || uint8(data[i]) < 0x20) return (false, bytes32(0), i);
            i++;
        }
        if (i == data.length) return (false, bytes32(0), i);
        bytes memory value = new bytes(i - start);
        for (uint256 j = 0; j < value.length; j++) value[j] = data[start + j];
        return (true, keccak256(value), i + 1);
    }

    function literal(bytes memory data, uint256 start, bytes memory word) private pure returns (bool) {
        if (start + word.length > data.length) return false;
        for (uint256 j = 0; j < word.length; j++) if (data[start + j] != word[j]) return false;
        return true;
    }
}
